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

## Step 2 (Codex follow-up, same branch): adapter + runner + default-off service hook

- **`learning/shadow-market-adapter.js`** — the deterministic market-capture-to-shadow adapter. It MIRRORS
  the market-lab sealed CAPTURE bundle format (manifest member sha256/bytes verified before a single row is
  trusted; a truncated/partial or altered member refuses the WHOLE bundle) and the `market-observation-1`
  row shape, without importing any market-lab module (the learning fence forbids it — same
  mirror-without-import pattern as learning/labels.js). Only FINAL, closed, non-provisional one-minute
  candles with real prices become decision candles; volume passes through EXACTLY as observed (absence stays
  absence); trade-flow exists only where TRADE observations were actually received and RAISES the candle's
  knownAt clock (never lowers it); depth only where a BOOK_SNAPSHOT exists. The decision clock of an
  opportunity is the LATEST actual receipt (knownAt) of its frozen window — no invented clocks. Maturation
  paths carry only observations known strictly AFTER the capture and at/before asOf.
- **`learning/shadow-runner.js`** — the bounded restart-safe driver: consumes injected bundle references
  (it starts no polling), drives the existing paced lane, and persists a per-market consumption cursor as a
  CONTROL row ON the tamper-evident chain. The cursor advances exactly to the last fully DISPOSED decision
  (captured/ineligible/deduped/refused-late); SHED work stays in front of it and is retried — queued work is
  never counted as completed, and a restarted runner over the same bundles replays NOTHING as fresh (proven:
  zero captured AND zero deduped after restart — the cursor filters before the lane; dedupe remains the
  structural backstop).
- **`learning/service.js` hook (the ONE allowed modification)** — a new optional `shadowRunner` injection,
  DEFAULT OFF: absent (every current composition; fly.js passes nothing), the tick report has no shadow leg
  and the status says `shadowLane: null` — behavior is unchanged. Present, each tick runs one bounded
  `runner.step()` fail-dark (a shadow failure never touches capture/maturation/learning) and the status
  carries the lane's honest counts. The service never constructs the lane itself (fenced by test).

## Base-branch gaps — updated honestly

1. ~~service integration absent~~ → the default-off hook now exists; the `simulated += 0` line itself is
   UNCHANGED (that counter belongs to the historical campaign runner, which is still the only thing that may
   increment it). The shadow lane reports its own counts in `status.shadowLane` instead of borrowing that one.
2. `learning/campaign.js` still rejects `PROSPECTIVE_SHADOW` as a campaign mode — unchanged, by design.
3. `fly.js` still caches the historical archive once and wires NO shadow runner — the lane runs only where a
   composition injects a runner; no live feed reaches it yet. **Live data remains unproven: the Replit sensor
   patch (local commit 1b87dd3, 64/64 focused tests) has no live-data proof yet and none is claimed here.**
4. `learning/prospective.js` still trusts self-reported clocks/metricValue — unchanged (owned elsewhere);
   `shadow-result.js` remains shaped for that future consumption, explicitly UNVALIDATED until the gate runs.

## Remaining integration blockers (exact)

- **fly.js wiring (deliberately absent):** construct `createShadowStore` + `createShadowRunner` with a real
  `bundleSource` naming the market-lab owner's sealed capture directories, and pass it as
  `startLearning({ shadowRunner })` — one composition-root change, owned by the host integration agent.
- **A live bundle source:** something must tell the runner which sealed CAPTURE bundles exist as the day
  progresses (the market-lab owner writes them; the runner only reads). Until then the lane processes only
  bundles it is explicitly pointed at.
- **Live-data proof:** no feed is claimed live; the Replit sensor patch's live verification is pending on the
  Codex side.
- **Promotion-gate consumption** of `buildShadowResearchResult` (validation stays the gate's law).
- **CLI/UI surfaces** if wanted (`runner.status()` / `store.status()` are JSON-ready).
- Judge-side integration waits for `codex/judge-review-2026-09-13` (`06d24a0`) — not merged, not edited here.

## What is OFF

No PR, no merge, no deployment, no PAPER/LIVE, no learned-selection or dynamic-sizing activation, no
paid/model/provider calls, no secrets, no access changes. Authority is NONE on every artifact.

## Step 3 (Codex review of 9200bef — activation-blocking defects fixed)

**P0-1 — quality parity.** The adapter accepted a fictional `FINAL` state; the real vocabulary has none
(`QUALITY_STATES`), and committed Kraken/Coinbase candles are `KNOWN` + `closed: true` + `provisional: false`.
Fixed in `shadow-market-adapter-2`, and the fixture problem is fixed at the root: every test fixture is now
built by the REAL market-lab makers (`makeObservation`/`makeCoverage`/`quality`/`subjectId` — imported by the
TEST only; the adapter stays fenced), so fixtures are actual normalizer output shapes and validate against the
real `observationError`/`coverageRecordError`. A parity test additionally pins every mirrored constant
(observation schema, bundle version, coverage version, canonical-JSON bytes, subject identity) to the real
contracts, asserts unique real observation ids, and the reader refuses `DUPLICATE_OBSERVATION_ID`. The root's
proven live Kraken+Coinbase observations will therefore be ACCEPTED, not discarded.

**P0-2 — through-horizon coverage.** `matureShadowCapture` previously let a contiguous prefix that never
reached `horizonEnd` mature at its last candle. Now: a stop/target exit that genuinely occurred inside the
observed span matures; every claim that depends on "nothing happened for the rest of the horizon" — the
HORIZON exit AND the limit-never-filled NEUTRAL — requires observed coverage through `horizonEnd`; a missing
tail is `UNMATURABLE_PATH_MISSING`, never a pretended maturity.

**P0-3 — coverage.jsonl consumed.** The reader now hash-verifies BOTH sealed members; a missing/tampered
coverage member refuses the bundle. Trade-flow exists ONLY over intervals the sealed coverage PROVES complete
(`OBSERVED`/`SUBSCRIBED` union with no overlapping `GAP/FAILED/DROPPED/EVICTED/ACCESS_BLOCKED` and no
`PAGINATION/ACQUISITION/CENSUS`-incomplete reason); a proven interval with zero trades is a REAL zero
(the SUBSCRIBED-continuity law); trades without proof yield NO flow. A candle overlapped by an incomplete
CANDLE interval is excluded. Depth obeys the KNOWN synchronized book law (`quality KNOWN`,
`payload.synchronized === true`, checksum not failed, no standing DESYNCHRONIZED/GAP book fact at its clock);
PARTIAL/desynced snapshots are never depth.

**P1 fixes.**
- Real Coinbase volume (observed `volumeBase`, `volumeQuote: null`) is eligible: the capture freezes the
  OBSERVED component set (`inputUnits.volumeComponents`), requires component consistency across the window,
  and synthesizes nothing.
- Runner `shadow-runner-2`: deterministic durable round-robin over sources (a CONTROL row), bounded reads per
  step with deferral (never starvation), and ONE merged batch per step sorted by decision clock → NEWEST
  window first → market — the lane's pacing floor cannot self-collide per source. Proven with 3 sources under
  a 2-bundle budget and real pacing.
- Same-receipt windows: the opportunity identity now carries the frozen window end
  (`opportunityIdOf(+windowEndTs)`), so one REST receipt stamping many candles yields distinct,
  non-colliding identities, ordered newest-window-first at an equal clock.
- Daily counters HYDRATE from the journal on restart (`store.evaluationsOn(utcDate)`): the 100k line cannot
  reset by restarting; queued/shed work is still never counted as completed.
- SINGLE WRITER: an exclusive `writer.lock`; a second store opens read-only (`WRITER_LOCK_HELD`); a stale
  lock is taken over with a DISCLOSED `WRITER_EPOCH` CONTROL row; and a `head.json` claiming more history
  than the journal carries refuses continuity outright (`JOURNAL_BEHIND_HEAD`) — a truncated/republished
  journal can never re-claim continuity from the inside.
- Sync-parse bounds: sealed members above 32 MB or 200k rows are refused
  (`SEGMENT_TOO_LARGE_FOR_SYNC_READ`) — the owner shards segments; the host thread is never jammed.

**Still true and unchanged:** no live bundleSource exists (no fly.js wiring; live-data proof stays on the
Codex side), no promotion-gate consumer runs, shadow outputs remain `UNVALIDATED_RESEARCH_RESULT` with
authority NONE and cannot reach activation, any ledger, or the Judge automatically — and no score anywhere is
learned authority.

## Step 4 (Codex review of b6a7964 — focused repair pass)

1. **Timed lock takeover REMOVED (P0).** Liveness is never inferred from a lock file's age — the old rule
   could mint two healthy writers. Now: FAIL CLOSED (a held lock means read-only, however old), and the only
   recovery is `recoverStaleLock: { confirmedBy, expectedToken }` — an EXPLICIT, operator-verified takeover
   naming the exact token it replaces (compare-and-swap; a stale expectation loses), disclosed as a
   `WRITER_EPOCH` CONTROL row. Belt-and-braces, every append re-verifies lock custody: a displaced writer
   stops with `WRITER_LOCK_LOST` instead of racing.
2. **Aligned-bar horizon (P0).** The horizon is PREDECLARED as a whole number of declared bars after the
   decision boundary (`horizonEndTs` = the aligned boundary, recorded on every outcome). Only bars ENDING at
   or before that boundary are usable — an offset decision (:00.200) can no longer read seconds of a partial
   bar's high/low/close from beyond the horizon. Spike-after-boundary regression proves a post-boundary bar
   changes nothing; mixed-granularity path bars are refused outright.
3. **Composite cursor (P0).** The per-market cursor persists `{ lastDecisionTs, lastWindowEndTs }` and the
   lane reports the exact cursor-safe disposed PREFIX (each entry with its immutable identity). Same-clock
   sibling windows are never dropped after a maxBatch/quota cut, and a market whose work was shed or deferred
   never advances. Proven with 2 markets × 2 same-receipt windows under maxBatch 1 across a restart.
4. **Producer parity tightened.** The declared-granularity law (`recipe.candlePeriodMs`): the real Coinbase
   owner's 3600s bars are consumed lawfully by a declaring recipe, and a 1m recipe REPORTS them as
   incompatible scope via the granularity census — never silent, never mixed. Candle coverage is now FAIL
   CLOSED (no proven interval = no decision candles). Book gap/desync facts are enforced from BOTH real
   sources — the sealed coverage.jsonl records and the observation-stream BOOK_COVERAGE facts — at USE time:
   a snapshot taken before a later gap can never serve a decision made after it. Honest limit: fixtures are
   real-contract-maker outputs validated by the real validators with the owner's exact parameters (3600s
   Coinbase, KNOWN quality, null volumeQuote); they are not full client-transport runs.
5. **Cross-segment outcomes.** Bundles of one market MERGE (rows deduped by observation id) within a step —
   a second bundle never overwrites the first — and `UNMATURABLE_PATH_MISSING` is RETRIABLE, never terminal:
   an adjacent sealed segment arriving later completes the path and the outcome matures then. Honest limit:
   segments complete a split path only when co-read in one step (they sort adjacent under the source key, so
   the rotation reads them together when the budget allows); persisting normalized candles across steps is a
   possible future extension, not claimed.
6. **Identities separated.** `opportunityId` (work identity) carries the window; `groupId` is the DECISION
   MOMENT only (`fsmom-…`, no window) — several windows born of one receipt share ONE dependence group and
   can never inflate independent evidence downstream. `primaryOpportunities` counts work items; groups count
   moments.
7. **Byte bounds, honestly stated.** Per-member cap cut to 8 MiB / 50k rows, plus a per-step 16 MiB byte
   budget in the runner. These cap BYTES, not wall time — a maximal read still parses synchronously and is
   not preemptible mid-member; worker/streaming isolation is the documented next step. No "never jams" claim
   is made anywhere. Likewise: the journal's hydration and JOURNAL_BEHIND_HEAD refusal are LOCAL tamper
   evidence on one filesystem — NOT external republish durability and NOT production durability; continuity
   beyond the local chain requires an external backing adapter that does not exist here.
8. **Windows portability.** The test fences resolve the repo root via `fileURLToPath` (the
   `new URL(...).pathname` form mis-renders `C:\C:\` on Windows).
