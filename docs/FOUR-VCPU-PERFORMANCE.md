# Bounded learning performance work

Status: local implementation and adversarial verification complete for the
bounded offline scope below; Linux source integration is a separate gate. Nothing
in this document starts production, enables a provider, commissions storage,
starts PAPER/LIVE trading, or authorizes a publish. Four vCPUs describe one
server's CPU allocation, not four isolated development computers.

## Changes and limits

- The existing data-only supervisor already separates collector and UI processes.
- The daily runner delegates result-receipt construction to the authoritative
  local store. The store still independently rebuilds the study, validates exact
  prepared-input/content/recipe identity, and uses disk-custody-checked writes.
  The redundant runner-side third study build is removed. There is no cross-run
  cache keyed only by coin, day or job ID, and no future-information shortcut.
- `tools/daily-study-process.js` hosts a bounded queue of fixed child
  processes. Default concurrency is one; the library ceiling is two. Each job
  has a fresh process/heap, bounded input and response sizes, deadline and
  explicit output ownership. Child startup overhead is real and disclosed.
  Process orchestration stays outside the pure learning package; its existing
  prohibition on subprocess/network imports is unchanged.
- All planner/store work runs in the child, including independent verification.
  This keeps synchronous study work out of the collector/control event loop.
  The child V8 old-space cap is not a total RSS/native-memory hard limit.
- `lib/runtime-pressure.js` measures parent process CPU/RSS/event-loop delay and
  available OS observations. Parent readings do not include study children;
  host RAM/CPU may not equal container or VM allocation. Missing aggregate
  child/VM readings remain UNKNOWN. A second worker requires explicit capacity
  and fresh aggregate CPU/memory evidence, not merely `os.availableParallelism`.
- Queue pressure stops new submissions separately from resource pressure stopping
  worker dispatch. Existing queued work must remain able to drain when resources
  are healthy. Sample failures/staleness block new heavy work. Running writes are
  not aborted simply because a resource threshold was crossed.
- Interrupted children may leave durable progress or a writer lock. No automatic
  timed lock takeover, lock deletion, receipt reset or raw-history deletion is
  performed. Retry requires inspecting the recorded outcome/custody.

## Explicit offline command

From the source root:

```sh
node tools/daily-study-offline.mjs --help
node tools/daily-study-offline.mjs --capture work/capture.json --declaration work/job.json --output-dir work/study-receipts
```

The input and output roots default to the current directory. They, and the
output directory's parent, must exist. The output must be a dedicated local
receipt directory, never a production data root. Input paths must be bounded
regular JSON files within the declared input root. The declaration must be an
existing valid `sealDailyStudyRunnerJob` result; the command does not invent a
catalog, coverage, source clocks or recipe.

This command intentionally permits one worker only. It waits for a usable
pressure sample, with a bounded admission timeout, and emits a small structured
research receipt. It does not start the collector, UI, database, scheduler,
provider, Judge, Watch, a trading simulator, promotion or order client. It is not
wired into `.replit`, package startup, or the published deployment.

## Measured optimization evidence

Local Windows / Node v24.18.0, synthetic fixture: 40 accepted markets and 1,200
ticker records. Five fresh-store trials per version:

| Measurement | Before | After |
| --- | ---: | ---: |
| Median elapsed study time | 1,285.7 ms | 700.2 ms |
| Attempted trading simulations | 0 | 0 |

This is approximately 45.5% less elapsed time on this fixture, not a production
speed multiplier. The same fixture's study and result digests were identical
in all ten trials. Study digest:
`4ff6203a51bcde632cd9c76cd41f492c2421480ab6cf4c29510f184166a00cc6`.
Result digest:
`eb55fc5d4b005562179ff8bb5e22d88936e03a0b36c0580f5a2fdc9eed87e47f`.

Five additional local child-process trials produced the same study/result
digests. Median elapsed job time was 801.2 ms, versus 700.2 ms directly; process
startup has overhead. A 10 ms parent heartbeat measured a median per-trial
maximum excess delay of 12.1 ms with isolation, versus 516.2 ms for five direct
trials. This is local responsiveness evidence, not total CPU savings or a
production latency guarantee. Parent CPU measurements exclude the child.

Final local combined verification covered 26 named test files: 177 tests,
176 passed, zero failed, and one existing Windows directory-fsync skip. The
unchanged learning-package subprocess/network fence passed. An offline guard
recorded zero outbound attempts. Independent adversarial review found no open
high-priority defects within this bounded scope. A real-monitor plus real-child
CLI smoke also admitted and completed the synthetic 40-market fixture with
identical digests and zero simulation credit. These are not full-application,
PostgreSQL integration, deployment, or production load-test claims. The Linux
fsync case remains a separate source-integration gate.

## Still required for the actual daily learning system

This is still a bounded partial-capture retrospective planner. It does not
provide full-day sharding, continuous durable raw capture/catalog epoch union,
a production schedule, realistic prospective trade outcomes, 100k simulations,
or adopted learning effects in Judge. Receipt files are LOCAL_FILESYSTEM_ONLY
and not republish-safe. Those prerequisites must be completed and verified;
CPU improvements cannot substitute for missing evidence or persistence.
