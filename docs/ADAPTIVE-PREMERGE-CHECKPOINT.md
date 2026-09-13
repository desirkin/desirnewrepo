# Pre-review checkpoint: automatic learning

Status: local implementation and isolated tests only. No change has been merged
into `work/runtime`, published, activated, or used to restart the running app.
The user said their code review is about to be supplied. **That incoming review
has not been received or signed off.** The findings below are independent local
inspection, not a substitute for the requested review.

## Recoverable checkpoint

- Root commit: `85e4264a6346940f1bc42de6e0cee3f4688e6d8d`.
- Tag: `checkpoint/pre-review-adaptive-root-20260913`.
- Bundle: `work/adaptive-pre-review-checkpoint-20260913.bundle` in the thread workspace.
- SHA-256: `a32707cd034e331973324ac26d42b5e5cbdb8f7f054374518efc292ae318a23e`.
- `git bundle verify` passed and confirmed complete history.
- This initial bundle includes the original shadow commit `dc3310a`, not its
  later candle-anchor correction. It does not contain the two agents' then
  uncommitted core/audit work. Those worktrees remain intact. A final all-branch
  checkpoint is required after they freeze and before app integration.

Original source34 snapshot and separate agent worktrees are preserved. There
is no remote configured for this isolated implementation repository.

## Independent findings against staged source

| Finding | Current treatment |
| --- | --- |
| Broad public capture could never start after an initially absent catalog | Fixed in staged root source; functional delayed-catalog test passes. Deep REST and catalog quota gates remain intact. |
| Missing explicit test path could be ignored by Node discovery | Local offline runner now checks every path exists, is a file, and is contained in the checkout before launching tests. |
| Shadow return target used decision+60m while naming the candle-aligned label recipe | Corrected by shadow owner in `2ea249ec763995f175c46a469f7c65f9dba55d7d`; root independently reran its 31-test cluster successfully. |
| Core prediction did not bind the sealed feature-recipe digest | Confirmed by root; fix and adversarial test in progress in isolated core branch. |
| Current learned state could be recorded under an earlier prediction timestamp | Confirmed by root; state-availability check and sealed persistence-lag bound in progress. |
| Core hash chain alone did not detect clean suffix truncation after close | Confirmed by root; fsynced acknowledged-head checkpoint and restart refusals in progress. Whole-directory rollback still requires external custody. |
| Old qualified/candidate states are not qualification of a new evolving procedure | Still open. Do not reuse old labels or synthetic passing fixtures to grant new authority. |
| Raw market facts, original predictions, maturity worker and paper consumer are not connected end-to-end | Still open. Numeric updates in module tests do not establish running adaptive behavior. |
| Local stores are not republish-safe external custody | Still open. No deployment decision is justified by local fsync alone. |

## Independent root test runs

Every run used the credential-stripping offline test runner; all reported zero
outbound attempts. Counts in different rows overlap and must not be added as
unique tests or independent evidence.

| Checkout / scope | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Staged root: broad collection, data-only launcher, audit hook, social bridge, sequential forecast | 35 | 0 | 0 |
| Staged root: existing Judge intake, V3 fact recipe, activation, promotion, maturation, integrity fences | 79 | 0 | 0 |
| Staged root: fixed readers, worker isolation, burst/pressure behavior | 43 | 0 | 1 |
| Shadow branch: uncertainty plus existing learning/consumer fences | 31 | 0 | 0 |
| Audit branch: frame/store plus existing contracts/integrity fences | 30 | 0 | 0 |

The skipped test requires symlink creation unavailable on this Windows host.
The pressure test measures the isolated local process, not Replit's 4-vCPU host.
These are correctness/containment tests, not trading-edge or calibration evidence.
No current production feed-health measurement was made by these offline runs.

## Next gate

Preserve a refreshed checkpoint, receive the user's review, map each relevant
finding to the actual current code and tests, and resolve or explicitly block
affected app integration. Continue isolated implementation in parallel. Do not
change authorized data collection or the runtime mode as a side effect.
