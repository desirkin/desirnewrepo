# LEARN-1 RUNBOOK — enabling the data-only learner and the bounded replay campaign

Doctrine: `doctrine/LEARNING.md` (authority table, promotion law, the one
control/configuration table). Everything below is data-only: no paper, no
orders, no live providers. Authorized here: enabling the tested data-only
learner and the bounded simulation campaign on the host. NOT authorized:
enabling PAPER or real trading.

## 1. Enable the learner on the host (data-only runtime)

```
LEARNING_ENABLED=true node fly.js        # or the existing supervised deployment command with the env var added
```

- The service registers with the fly.js composition (constructed dark,
  unref'd timers, fails dark). Heartbeat + counters: `data/learning/status.json`.
- Verify: `node bin/cobra.js learning status` — expects `state: RUNNING`,
  a recent `lastTickTs`, `authority: NONE`, and the law line
  `COLLECTOR_RUNNING_IS_NOT_LEARNER_RUNNING_IS_NOT_VALIDATED_ADAPTIVE_BEHAVIOR`.
- Cockpit: `GET /api/learning` (read-only panel).
- Maturation requires the promoted Childhood archive at `<dataDir>/childhood`;
  without it the status reports `ARCHIVE_UNAVAILABLE` and episodes stay
  honestly pending.

## 2. Preflight the replay campaign (read-only)

```
node bin/cobra.js learning preflight [--archive DIR] [--grid-minutes 30]
```

Reports the ACTUAL retained 1m history (assets, bars, coverage ends,
eligible unique opportunities) and the bounded-sample source-delay evidence.
`ready: false / CHILDHOOD_ARCHIVE_ABSENT` means the host has no archive —
build/promote one first (`node childhood/build.js`); a working API key is
not proof of data.

## 3. Declare and run the bounded campaign

```
node bin/cobra.js learning campaign-declare --target 100000 --seed <seed> [--grid-minutes 30]
node bin/cobra.js learning campaign-run --id <campaignId> --max 5000 --max-wall-ms 300000
node bin/cobra.js learning campaign-status --id <campaignId>
node bin/cobra.js learning campaign-pause --id <campaignId>    # retains all results; resume continues without duplication
node bin/cobra.js learning campaign-resume --id <campaignId>
```

- The manifest is persisted BEFORE execution and is immutable.
- Each run is bounded (opportunities + wall clock); repeat `campaign-run`
  until `COMPLETED` or `EXHAUSTED_SUPPORTED_HISTORY` (the exact shortage is
  shown — nothing is padded to 100,000).
- `campaign-run` prints measured throughput and an estimate explicitly
  conditional on it. Measure a small batch first; do not schedule from a
  guess.
- Recurring execution on the host: run bounded `campaign-run` slices from
  the existing supervisor/cron the deployment already uses (one at a time —
  results are append-only and idempotent, but the checkpoint writer is a
  single-owner file). If no supervisor slot exists, run slices manually; a
  temporary shell exiting does NOT keep anything running, and this runbook
  does not pretend otherwise.

## 4. Read the learning state

```
node bin/cobra.js learning patterns          # provisional memory heads (raw vs group counts, estimate, contradictions)
node bin/cobra.js learning summary [--date YYYY-MM-DD]
```

## 5. Kill switch (learned influence only)

```
node bin/cobra.js learning kill   # adapter answers baseline; collection/learning continue
node bin/cobra.js learning arm
```

## 6. GDELT verification step (addendum; host-side, once)

After the GDELT rate limit clears (respect Retry-After; no repeated
retries), run ONE normal existing discovery collector cycle — the collector
lives in the concurrent Codex branch, not here — and confirm the saved
article through its normal reader (`node bin/cobra.js discovery tail` on
that branch). Keep continuous GDELT polling disabled until that succeeds.

## 7. Addendum 2 / dynamic sizing — the two switches (both OFF)

Nothing in the running host consumes learned selection or dynamic sizing:
`fly.js` passes neither port. To run a SHADOW-mode experiment in a clone
(NOT the live checkout; PAPER/LIVE stay off):

```js
// composition-level (snapshot cached 60s, staleness law still applies):
const run = await composeJudge({
  ...existingArgs,
  learningActivationSource: () => readDecisionMemory({ store, nowTs: Date.now() }),
  dynamicSizing: true,
});
```

Every influenced decision then carries `LEARNED_RANK_ADJUSTMENT` and/or
`DYNAMIC_SIZE_SELECTION` measurement rows (selector/ladder version, reason,
every candidate size). Removing the two arguments restores baseline
behavior exactly — proved by test/judge-learning-intake.test.js rigs.

Diagnostics (no live transport in this branch — registration + fixtures only):
the harness lives in learning/diagnostic.js; a real probe requires an
authorized budget and a caller-supplied transport, and parks as
WAITING_FOR_BUDGET when the budget is spent.

Integrity/status surface: `GET /api/learning` → `integrity` section
(evidence by basis, diagnostics, switch states, selector + sizing versions).
