# LEARNING DOCTRINE — continuous learning without self-deception (LEARN-1)

> **One observation may create a memory. It may never, alone, change behavior.**
>
> **Dependent repeats are not independent confirmations. Raw counts and effective
> group counts are both shown, always.**
>
> **UNKNOWN is not FALSE. CENSORED is not a loss. A price spike with no supported
> entry and exit is descriptive movement, never guaranteed missed profit.**
>
> **A pattern earns PAPER influence only through a sealed, frozen, forward test —
> and even then through one bounded, versioned, revocable score adjustment.**
>
> **A running collector is not a running learner. A running learner is not
> validated adaptive behavior. The status line says which is which.**

Code: `learning/` (contracts, store, features, capture, maturation, grouping,
estimator, patterns, prospective, promotion, adapter, campaign, continuous,
questions, summary, service, commands, source-delay). Tests:
`test/learning-*.test.js`. CLI: `cobra learning <sub>`. UI: `/api/learning`.
Runtime: `fly.js` behind `LEARNING_ENABLED=true` (data-only; timers unref'd;
fails dark). Storage: `<dataDir>/learning/` (append-only JSONL journals,
revalidated on read; atomic status/checkpoints; nothing deleted or repaired
in place).

## 1. Four authorities, structurally separate

| Authority | Module | May do | May never do |
|---|---|---|---|
| A. Collection | `service.js` capture tick | coverage ledger + immutable episode snapshots from the wide eye's completed sweep population (injected read-only seam) | start provider polling, touch a sensor, place attention/nomination state |
| B. Learning | `maturation.js`, `patterns.js` | attach matured outcomes (separate records), update provisional pattern memory at group level | mutate an episode, mutate a frozen/active pattern, promote anything |
| C. Shadow assessment | `prospective.js` captures | freeze hypothetical decisions before outcomes exist | orders, baseline changes |
| D. Bounded paper adjustment | `adapter.js` | apply an ACTIVE_PAPER activation's allowlisted score adjustment when a separately authorized paper runtime asks | hard gates, liquidity/exit safeguards, fees, risk limits, leverage, order mechanics, The Watch, budgets, trading mode |

Live-order authority is supplied by none of these. Socrates remains the
interpreter; the Judge remains the final decision function; The Watch keeps
position priority. `learning/` imports no `execution/`, `judge/`, `watch/` or
`tape/` module (fenced by `test/learning-fences.test.js`), and mirrors the
referee's prospective law without importing `research/referee/` (its import
fence is structural). It DOES reuse the existing label recipe — `labelRow`
from `research/outcomes.js` — and the existing archive reader
(`research/archive.js`): no second labeler, no second candle census.

## 2. Honest counting

One PRIMARY opportunity = canonical asset + decision timestamp + capture
recipe version + dataset identity (`opportunityIdOf`). Variants (e.g. the
delayed-entry candidate), extra horizons and stress trials carry their own
counters and never increment the primary count. Dependence groups
(`grouping.js`): one asset within a 4h window is one episode group; declared
common-shock dates fuse groups across assets; the output is labelled
`APPROXIMATE_GROUPING_NOT_EXACT_INDEPENDENCE`. Evidence bases stay separately
countable: `HISTORICAL_RECONSTRUCTION` (replay over archives acquired later),
`CONTEMPORANEOUS_HISTORICAL`, `PROSPECTIVE` (fresh forward), `SYNTHETIC`
(never counts toward any real-evidence floor).

## 3. The estimator

`estimator.js`: Beta-Binomial shrinkage toward the pooled applicable
setup/regime rate with a documented prior strength, evaluated over GROUP-level
aggregates; normal-approximation intervals labelled as such. Contradictory
groups pull the posterior down exactly as supporting groups pull it up —
confidence is not monotonic, and `confidence += 0.1 on a win` does not exist.
Censored / not-yet-known / unavailable outcomes are excluded and counted.

## 4. Pattern lifecycle

`NOTICED → ACCUMULATING → CANDIDATE_FROZEN → PROSPECTIVE_PENDING →
VALIDATED_PAPER → ACTIVE_PAPER → DEGRADED → RETIRED` (closed transition table
in `contracts.js`; the store refuses an out-of-order or unlawful transition).
A failed prospective returns the pattern to ACCUMULATING with the failure
retained; the candidate id stays consumed; history is never erased.

## 5. Promotion — one visible policy, machine-enforced

`promotion.js PROMOTION_POLICY`: anti-shortcut floors (>= 30 matured
prospective dependence groups, >= 7 distinct UTC dates, >= 5 distinct assets),
terminal sample target >= floors, matured-coverage rule (>= 0.8; dropping
difficult outcomes cannot manufacture improvement), sealed alpha 0.05,
paired candidate-vs-baseline comparison over the SAME opportunity stream
(newly admitted losers and forgone gains both count). The floors are
ENGINEERING SAFEGUARDS, not proof of statistical power; required samples may
be much larger; date passage alone earns nothing. One terminal look per
candidate; interim views carry `INTERIM — NOT A FORMAL CONFIRMATION`; a
design change is a new candidate. Anytime-valid sequential inference is NOT
implemented — exactly as in the referee — and repeated significance checks
are therefore not available to bypass the endpoint.

## 6. The bounded adapter

`adapter.js applyLearnedAdjustment`: per-activation cap (<= 0.15 baseline
score units), aggregate cap across simultaneously applicable activations
(<= 0.25, proportional squeeze disclosed), expiry (<= 90 days), applicability
predicate answering OUT_OF_DOMAIN as no-contribution, kill switch
(`data/learning/kill.json`, separate from collection/learning; corruption
fails toward LESS learned influence), baseline score always preserved beside
the effective score, and fallback-to-baseline with the reason on any invalid
/ stale / corrupt state. Degradation follows the activation's own predeclared
rule (min groups >= 2 windows — a lone loss can never flip anything);
rollback is an appended transition with cooldown. Activation records bind
training cutoff, candidate digest, evidence/report digests, allowed effect,
previous version and effective time. While PAPER is stopped the strongest
state reachable is `PUBLISHED_WAITING_FOR_PAPER` / pattern `VALIDATED_PAPER`.
Wiring the adapter into the paper assessment path is a one-line composition
change gated on the separately authorized paper runtime; it is deliberately
NOT wired while paper is off.

## 7. The replay campaign (§17) and continuous research (§18)

`campaign.js`: manifest persisted BEFORE execution (immutable), deterministic
outcome-independent grid enumeration over the ACTUAL retained Childhood
archive 1m track, resumable bounded chunks (idempotent result identities —
counts always derive from the deduplicated validated read, so a crash
mid-chunk equals an uninterrupted run), fidelity ladder with intrabar
ambiguity UNRESOLVED or ADVERSE_FIRST (never optimistic), both-side fees and
slippage, delayed-entry variant deciding at its own later clock and paying
the later supported price. Supported history smaller than the target ends as
`EXHAUSTED_SUPPORTED_HISTORY` with the exact shortage — nothing is
manufactured to reach 100,000. Kraken REST serves at most ~720 bars per
interval, so deep replay depends on the promoted Childhood archive on the
host; preflight (`cobra learning preflight`) reports what actually exists.

`continuous.js`: two durable queues with separate progress (bootstrap replay;
fresh capture + maturation). The 10,000/day figure is a WORKLOAD target —
never a quota, evidence threshold or promise; unsupported capacity runs the
supported workload and names the limit. Coverage floor via deterministic
rotation (no invented inclusion probabilities), per-asset ages published
(p50/p95/max, starved list), overload sheds change-driven extras before
baseline coverage and exposes the shed counts.

## 8. Questions and the daily summary

`questions.js`: the closed research-question registry (families §19 A–I);
trials are charged against explicit budgets; failed hypotheses stay
registered; a MISSED_MOVE_AUDIT is outcome-selected by definition and never
enters a primary success-rate denominator. `summary.js`: the daily summary is
derived from stored records only and separates "what I think I am noticing"
from "what has earned decision influence".

## 9. Control / configuration table (the ONE table)

| Concern | Configuration | Default | Active value source | Process owner | Allowed side effects |
|---|---|---|---|---|---|
| Collection (capture+coverage) | env `LEARNING_ENABLED` | unset (OFF) | fly.js environment | data-only runtime (fly.js) | writes under `<dataDir>/learning/` only |
| Learning (maturation+patterns) | same flag; archive presence gates maturation | OFF; `ARCHIVE_UNAVAILABLE` without an archive | `<dataDir>/childhood` presence | learning service tick | appends outcome/pattern records |
| Replay campaign | `cobra learning campaign-declare/-run` (explicit CLI, bounded per run) | no campaign | campaign manifest + checkpoint | operator CLI process | writes `learning/campaigns/<id>/` only |
| Shadow assessment | sealed designs in `learning/prospective.jsonl` | none | prospective journal | learning service / CLI | appends captures/outcomes |
| Adaptive paper influence | activation records + `data/learning/kill.json` + a separately authorized paper runtime | dormant (`ARMED` kill state, no ACTIVE_PAPER activation, adapter unwired) | activation heads + kill file | paper runtime (when separately authorized) | one allowlisted score adjustment |
| Real trading | UNCHANGED — Judge LIVE law (`judge/policy.js`, owner arming) | OFF | not reachable from learning | Judge composition | none from LEARN-1, ever |

There is no generic enable flag that could start trading: `LEARNING_ENABLED`
constructs only the data-only service above.

## 10. Discovery-source delay addendum (2026-09-13)

Owner-measured, BOUNDED-SAMPLE evidence (five provider pages per source —
never generalized beyond that sample), carried in
`learning/source-delay.js PROVIDER_DELAY_EVIDENCE` and surfaced in the
service status and `cobra learning preflight`:

- Polymarket event→receipt: median ≈ 1m58s, max 4m35s (bounded sample).
- Kalshi event→receipt: ≈ 4h15m in the sampled records (max not established).
- GDELT: UNAVAILABLE_RATE_LIMITED — delay unverified. **Continuous GDELT
  polling stays disabled** until, after the rate limit clears (respect
  Retry-After; no repeated retries), one normal existing collector cycle on
  the host saves an article confirmed through the normal discovery reader.
  The discovery collector/storage/deduplication path and its reader
  (`cobra discovery tail`) live in the concurrent Codex work, not in this
  branch; LEARN-1 deliberately adds no second client, no polling and no
  journal for these sources.
- Timestamp law: provider publication/event time, discovery time and receipt
  time are three clocks, never merged; an event is USABLE at receipt
  (`usableAtTs` in the episode schema); a horizon a delay makes unreachable
  is UNSUPPORTED for that opportunity (`horizonSupportedForSource`).
- Market matching requires STRONG crypto evidence — cashtag, crypto hashtag,
  venue pair, or an approved unique alias. A bare ticker-shaped word ("NOT")
  is `UNMATCHED_WEAK_TICKER`: unmatched/uncertain, never crypto evidence
  (`matchStrength`).
- The older discovery ZIP/hash from the source transcript is reference
  evidence only; nothing is reset from it. No credential from any transcript
  is requested, copied or used; Claude cloud sessions activate no live
  provider.

## 11. What LEARN-1 does NOT claim

No calibrated edge; no validated pattern exists at delivery; the engineering
baseline rule (`learning-baseline-rule-1`) is not the live Judge and claims
no live parity; synthetic demonstrations never count as live success;
insufficient real observations is an honest "collecting evidence" state.
PAPER and real trading remain OFF and are not started, armed, or made more
likely by anything in this ticket.
