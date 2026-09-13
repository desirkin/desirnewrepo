# FORWARD-SHADOW LANE (isolated branch `claude/forward-shadow-learning-2026-09-13`)

A BOUNDED, separate forward-shadow research lane: throughout each day it captures hypothetical TAKE-versus-
ABSTAIN decisions and predeclared size/entry/exit variants over the EXACT then-known completed candles
(volume and trade-flow first-class; social/news contextual unless a recipe declares them required), and
matures them later against the SUBSEQUENTLY OBSERVED real market path. This is David's intended 100k/day
workload — it is NOT a historical backtest, NOT the replay campaign, NOT Judge eligibility, and NOT deployed.

## Modules (all NEW; no owned file was modified)

| Module | Role |
|---|---|
| `learning/shadow-contracts.js` | closed vocabulary, validators, identities, canonical digests |
| `learning/shadow-store.js` | restart-safe tamper-evident journal: store-owned ingestion clocks, digest chain + contiguous sequence, anti-backdating, dedupe, durable-byte accounting |
| `learning/shadow-capture.js` | the capture law: freeze input digest, scope, completed windows, units/freshness/knownAt, recipe/cost versions, decision clock, variant identity; INELIGIBLE with the exact reason — never zeros/backfill |
| `learning/shadow-outcome.js` | maturation on the real subsequent path: PENDING before horizon; fees/spread/latency under the SEALED cost policy; stop/target same-candle ambiguity resolves conservatively and is flagged; explicit CANDLE_ONLY downgrade; candle-only can never mint size evidence |
| `learning/shadow-lane.js` | paced bounded batches under quotas (daily target, batch size, wall-clock, durable bytes, pacing floor), cancel/stop, backpressure recorded as SHED, honest status |
| `learning/shadow-result.js` | the PREPARED, EXPLICITLY UNVALIDATED research result (paired TAKE−ABSTAIN by dependence group) for the existing promotion gate to consume LATER |

Proving test: `test/shadow-lane.test.js` (10 tests) — clock spoofing/backdating, chain tamper evidence,
restart idempotence, future-known/late/missing-volume/missing-trade-flow/stale/gap ineligibility, no
lookahead, PENDING-before-horizon, TAKE/ABSTAIN pairing, same-moment variant dependence (one group),
stop/target ambiguity, fidelity + size-evidence law, quota pacing/backpressure/cancel, immutability,
separation fences (no order/ledger/Judge/Watch/network surface). The repo-wide fences
(learning-fences, integrity-boundary, referee/rumor2 authority, social-5b) all pass over the new files.

## Laws (short form)

- **The store owns time.** `ingestedTs` is stamped by the store clock; rows are chained
  (`seq`, `prevDigest`, `digest`) and verified on every open; a capture whose `decisionTs` is more than
  `maxCaptureLagMs` (default 10 min) behind — or ahead of — the store clock is refused
  `LATE_CAPTURE_AFTER_THE_FACT`. A tampered journal becomes read-only evidence: no further appends.
- **Ineligible, never invented.** Required missing/stale/incomplete/future-known facts refuse the whole
  opportunity with one of the closed reasons. Nothing is zero-filled or backfilled.
- **Honest counting.** One opportunity (venue+asset+decisionTs+recipe) is ONE primary unit; its variants share
  ONE dependence group (`groupId = opportunityId`) and never inflate the primary count; duplicates are refused
  and counted as `deduped`, never re-counted. The 100k/day figure is a WORKLOAD target, never an edge claim —
  the status object says so in its own field.
- **Real futures only.** Maturation consumes candles that STARTED at/after the decision and became KNOWN after
  it (and at/before `asOf`); holes are `UNMATURABLE_PATH_MISSING`. No fabricated future path exists anywhere.
- **Fidelity honesty.** No depth ⇒ `CANDLE_ONLY`, with `ENTRY_FILL_ASSUMED…`, `PARTIAL_FILL_UNKNOWABLE…`,
  `SPREAD/LATENCY_ASSUMED…` flags on every touched outcome, and `sizeEvidence = NONE_AT_CANDLE_FIDELITY`
  structurally — an L-tier variant at candle fidelity mints no size evidence.
- **No order surface.** No order, ledger, Judge, Watch, execution or network import can exist in the lane
  (fenced by test); the only durable artifact is the immutable research journal.

## Base-branch gaps this lane does NOT solve (named honestly, per the coordination brief)

1. `learning/service.js` still advances `simulated += 0` against its 10k/day budget — the daily simulation
   budget is NOT yet routed to this lane (service.js deliberately untouched; the hook is a one-line
   integration for the owning agent).
2. `learning/campaign.js` still rejects `PROSPECTIVE_SHADOW` as a campaign mode — the historical campaign and
   this lane remain separate by design, and the campaign's own mode handling is unchanged.
3. `fly.js` still caches the historical childhood archive once at startup — the host cannot feed this lane
   live candles yet (no fly wiring was added, per instruction).
4. `learning/prospective.js` still trusts self-reported clocks and `metricValue` — the sealed prospective
   pipeline (owned elsewhere) does not yet consume this lane's store-owned clocks and net-after-costs
   outcomes. `shadow-result.js` is shaped for that future consumption; nothing consumes it automatically.

## Remaining integration blockers (for the owning agents)

- Route `learning/service.js`'s daily simulation budget to `createShadowLane.runBatch` (smallest hook; the
  lane already paces itself) and its maturation sweep to `matureBatch`.
- A live candle/trade-flow feed adapter for opportunity preparation (host-side; the lane takes prepared
  inputs only).
- Promotion-gate consumption of `buildShadowResearchResult` output (validation stays the gate's law; the
  result is explicitly UNVALIDATED until then).
- CLI/UI surfaces if wanted (`status()` is JSON-ready).

## What is OFF

No PR, no merge, no deployment, no PAPER/LIVE, no learned-selection or dynamic-sizing activation, no
paid/model/provider calls, no secrets, no access changes. Authority is NONE on every artifact.
