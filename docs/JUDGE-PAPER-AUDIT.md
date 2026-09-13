# JUDGE — PAPER AUDIT AND FROZEN STATE

Verdict: `JUDGE_PAPER_COMPLETE`

Scope: `judge/*.js` (26 modules), `execution/*.js` (12 modules), `watch/watch.js`. Audited 2026-09-11 for the SERPENT
final paper closeout. The audit asks ONE question per law: is the PAPER path complete, truthful and closed (no stub, no
inferred authority, no lowered threshold), and is that proven by a test that fails when the law is broken?

## 1. Method

1. Static sweep of the three trees for stub markers (`TODO`, `FIXME`, `NOT_IMPLEMENTED`, `not implemented`, `placeholder`,
   `HACK`): zero hits.
2. Every module header names its ticket law; every law below cites the module and the test that proves it.
3. The PAPER vertical runs end to end over the REAL composition and PostgreSQL under the paper PROFILE
   (`test/paper-e2e-pg.test.js`, PE2E-1 / PE2E-2) — not over a mock Judge.
4. The three trees were NOT modified by the closeout (see §4: the frozen digests equal the baseline tree).

## 2. Laws and their proofs

| # | Law (PAPER) | Where | Proof |
|---|---|---|---|
| 1 | The paper profile's Judge policy IS the reviewed reference; no threshold, cap, lock, fee or evidence requirement changed | `config/judge.paper.json` byte-identical to `judge/samples/policy.paper-reference.json` | `test/paper-runtime.test.js` P-01, `test/paper-e2e-pg.test.js` (module load), `test/judge-focused-fences.test.js` C01 (reference sha pinned) |
| 2 | JUDGE_MODE is PAPER; JUDGE_ALLOW_PRIVATE / JUDGE_ALLOW_ORDERS are false and never inferred from credentials | `paper/profile.js` FORCED_ENV, `paper/launch.js` prepareLaunch, `judge/composition.js` readCredentials (LIVE only) | P-01, PE2E-2(e): a LIVE environment with key names present composes a PAPER run with `credentialsPresent=false`, transport never called; `composeJudge(LIVE_ARMED, paper policy)` refused |
| 3 | ONE shared entry-permission law (controls, restrictions, mode, authorization, clock, writer) before any reservation and again before any send | `execution/authority.js` entryPermission; `judge/judge.js` decide; `execution/dispatcher.js` pre-send | `test/judge-repair-authority.test.js` (R01), PE2E-2(b) KILL -> `ENTRY_REFUSED [KILL]`, PE2E-2(c) RECONCILIATION_REQUIRED refuses entry |
| 4 | KILL / CAGE / VETO preserved; hard restrictions clear only with owner intent | `execution/reducer.js` RESTRICTION (OWNER_CLEAR_REQUIRED), `judge/arming.js`, `judge/commands.js` | `test/judge-reducer.test.js`, `test/judge-repair-authority.test.js`, PE2E-2(c) CLEAR without ownerRef refused |
| 5 | A sealed Socrates case is READ-ONLY input, verified by bytes, refused when synthetic / from the future / stale; it never vetoes a market-driven setup by accident | `judge/case-source.js`, `judge/case-verify-worker.js`, `judge/intake.js` | `test/judge-e2e-pg.test.js` E2E-1, `test/judge-repair-evidence.test.js`, `test/judge-decisions.test.js` |
| 6 | Deterministic versioned setups over point-in-time facts; readiness is never permission; a silent socket breaks coverage and stops entries | `judge/setups.js`, `judge/readiness.js`, `judge/features.js`, `execution/feed.js` liveness | `test/judge-decisions.test.js`, `test/judge-feed-clock.test.js`, PE2E-2(a) silent market -> no entry, readiness not READY |
| 7 | Cost-aware admission with exact decimals; positive gross / negative net refuses; reward / stressed risk screen; largest legal lot inside cash, risk and cluster caps | `judge/cost.js`, `judge/risk.js`, `execution/money.js`, `execution/fees.js` | `test/judge-cost-capital.test.js` (0.8% reference refusals), `test/judge-money.test.js`, `test/judge-repair-accounting.test.js` |
| 8 | PAPER adapter: same instruments, reservations, fees, controls and lifecycle as LIVE; fills ONLY from observed book levels with depletion; never a convenient fill; pending at a crash -> EXPIRED (UNFILLED_COVERAGE_UNKNOWN) | `execution/paper-adapter.js` | `test/judge-adapters.test.js`, `test/judge-repair-restart.test.js`, PE2E-1 fill + protection |
| 9 | ONE account reducer validates every cause / reference relation and quantity sum; a FILLED status without executions is refused; late messages reconcile, never erase | `execution/reducer.js`, `execution/contract.js` | `test/judge-reducer.test.js`, `test/judge-repair-accounting.test.js` |
| 10 | PostgreSQL is the journal authority for PAPER; ONE writer per account, epoch-fenced; the chain replays and verifies; restart never mints a fresh USD 500 | `execution/journal.js`, `execution/dispatcher.js`, `judge/composition.js` start (replayVerify) | `test/judge-journal-pg.test.js`, `test/judge-repair-pg.test.js`, PE2E-1 replayVerify, PE2E-2(d) |
| 11 | Restart reconciles BEFORE any addition; uncertain orders / exposed positions reported; an incomplete reconciliation latches RECONCILIATION_REQUIRED | `execution/dispatcher.js` restart, `execution/paper-adapter.js` reconcile | `test/judge-repair-restart.test.js`, PE2E-2(c) latch survives restart |
| 12 | Watch: exposure first until exchange-confirmed flat; protection child before anything else; deterministic exit reasons (deterioration, invalidation, time, health); feed unusable -> halt with native stops retained | `watch/watch.js` | `test/judge-watch.test.js`, `test/judge-repair-exit.test.js`, PE2E-1 deterioration -> FLAT, PE2E-2(d) Watch resumes RESTORED |
| 13 | Projection / posture agree with the journal and are bound to the account, run mode and revision; a LIVE projection can never read as paper | `judge/composition.js` publishProjection, `state/execution-projection.js` | `test/judge-repair-projection.test.js`, `test/paper-runtime.test.js` P-04 (LIVE projection -> BLOCKED) |
| 14 | Permission clock: wall time observed, monotonic intervals; untrusted clock blocks LIVE and is recorded | `execution/clock.js`, `judge/replay-clock.js`, `judge/scheduler.js` | `test/judge-feed-clock.test.js`, `test/judge-repair-runtime.test.js` |
| 15 | Evaluation / challengers / holdout / release chain: nothing here grants authority; a paper result is a hypothesis until the independent chain says otherwise | `judge/evaluation` path in `judge/challengers.js`, `judge/experiment*.js`, `judge/arming.js` | `test/judge-evaluation.test.js`, `test/judge-holdout-truth.test.js`, `test/judge-experiment-*.test.js`, `test/judge-repair-arming.test.js` |
| 16 | The real Kraken adapter exists and is never reached by a PAPER run; a LIVE run needs a LIVE policy, an arm, a venue owner slot and an executions socket | `execution/kraken-adapter.js`, `judge/composition.js` | `test/judge-repair-kraken.test.js`, `test/judge-e2e-pg.test.js` E2E-2, PE2E-2(e) |

Test evidence for the three trees: 178 tests across `test/judge-*.test.js` and `test/paper-e2e-pg.test.js`; the full
regression at closeout is recorded in the final report (§11).

## 3. Bugs found by this audit

None in `judge/*`, `execution/*` or `watch/watch.js`. Two defects were found and repaired OUTSIDE the frozen trees while
wiring the paper profile: the sensor snapshot read the Judge projection from the process data dir instead of the snapshot's
own data dir (`paper/readiness.js`), and the dark-capture freshness law used a fixed 30-minute window although the runner
publishes per sealed segment (`paper/readiness.js`; now two segment lengths). Both carry regressions in
`test/paper-runtime.test.js` P-04. The bounded paper soak (`npm run paper`, 120 s, SIGTERM, exit 0) then found two more
defects outside the frozen trees, both repaired with regressions: the dark capture runner did not create its own
segments directory, so the capture command refused every segment (`paper/dark-capture.js`; P-06), and the sensor
snapshot derived DARK_CAPTURE_OPERATIONAL from a fresh heartbeat while the runner's own state said
DARK_CAPTURE_BLOCKED_EXTERNAL (`paper/readiness.js`; P-04). The Judge, execution and Watch trees needed no change.

## 4. FROZEN_FOR_PAPER

The three trees are frozen for the paper run. Any change to them must update this section (the fence in
`test/paper-runtime.test.js` P-08 recomputes these digests from the working tree and refuses a silent edit).

Digest law: `sha256` over the sorted repository-relative file list, each entry as `path + "\n" + bytes`.

```
FROZEN_FOR_PAPER
judge/*.js       767bb48158adff3678d39b24ff5c1b45e12d5561e3cc8fb49de2ff4957a19c3f
execution/*.js   d9ce90d9b08977048fb333bb8a22b7e949613832193a58763238d79a9d671965
watch/watch.js   dc49a39444e2971dafb766f2a831fda6894968238606c7c6bfa8b5b782cf53a6
all (41 files)   9012dd402d57c22ca1477eafd12128498ecef296146134f550d18ed4c161f90a
```

### 4.2 Audited change — 2026-09-13 dormant learning/sizing ports (previous digests: judge `187fbace4d56…`, all `075ecd3aecef…`; execution/ and watch/watch.js byte-identical)

The continuous-learning branch (`claude/continuous-learning-2026-09-13`, ADDENDUM-2 + final sizing addendum)
adds two null-default consumer ports to the Judge. Nothing operational changes while they are unwired, and the
production composition root (`fly.js`) wires NEITHER — proved structurally by `test/integrity-boundary.test.js`
and behaviorally by `test/judge-learning-intake.test.js` (rig comparison: with both ports absent, decisions,
refusals, rankings, sizing and risk math are identical to baseline on identical recorded inputs).

- `judge/learning-intake.js` (NEW) — the ONE bridge to validated learning artifacts. Imports only
  `learning/contracts.js` + `learning/features.js`. Deterministic versioned selector (`learning-selector-1`),
  conservative tie-break, baseline fallback on no-match / staleness (15 min) / invalid artifact / scope or
  eligibility miss / conflicting active versions / kill switch. Consumable axis: RANKING only, bounded by the
  frozen `adjust` within `maxAbsAdjust`. Contribution is logged as a `LEARNED_RANK_ADJUSTMENT` MEASUREMENT row.
- `judge/size-ladder.js` (NEW) — the size ladder over the UNCHANGED `sizeSearch` cost law (imports only
  `./cost.js` + `../execution/money.js`). Fractions 0.25/0.5/0.75/1 of the risk-bounded spendable; risk caps
  bind at every size; a missing/one-sided book selects nothing; every candidate size and rejection reason is
  recorded (`DYNAMIC_SIZE_SELECTION`). All-in is only ever flagged eligible when fraction 1 strictly wins.
- `judge/judge.js` — `createJudge` gains `learning = null` and `dynamicSizing = null` parameters; when null
  (the default and the production state) the decide() pipeline is unchanged. No threshold, gate, authority,
  order permission, admission rule or risk rule was modified.
- `judge/composition.js` — `composeJudge` gains pass-through parameters (`learningActivationSource`,
  `dynamicSizing`), both defaulting to null/off, with a 60-second-cached snapshot accessor when supplied.
- No change to thresholds, sizing defaults, risk, gates, authority, order permissions or the paper runtime;
  PAPER and LIVE remain OFF; both new ports remain unwired in `fly.js`.

### 4.1 Audited change — 2026-09-12 operational repair (previous digests: judge `ca3b1c8f0b2e…`, execution `1885a471b7d2…`, all `cbdf08784769…`)

Two reproduced runtime defects were repaired inside the frozen trees. `watch/watch.js` is byte-identical. Evidence and
before/after counters: `docs/evidence/operational-repair-2026-09-12.md`; regressions: `test/judge-operational-repair.test.js`.

- `execution/feed.js` — the venue sends ONE book snapshot per subscription, so a symbol admitted AFTER the tape's book
  subscription had no synchronized book and every later `update` hit the not-synchronized guard: books stayed at ZERO for
  the whole run while trades flowed. The feed now asks the bound tape for a REAL venue snapshot (bounded, rate-limited,
  `requestBookSnapshot`), keeps the public instrument PRECISION for every announced pair (so `crcVerified` can become true
  for a later admission), and starts a carried symbol's trade coverage at the ADMISSION clock. No depth is manufactured,
  no stale depth is reused as current, and the synchronization / CRC / freshness laws are unchanged. Authority unchanged.
- `judge/readiness.js` + `judge/composition.js` — a standing nomination list that carries no nomination clock was
  re-stamped with the current clock on every pass, so the six preparation slots flipped between disjoint groups every
  cadence and warmup never accumulated. The nomination's KNOWN-AT clock (rank) is now separated from its LAST-AFFIRMED
  clock (expiry). Warmup lengths, eligibility clauses, capacity limits, held-position protection and legitimate expiry
  are unchanged; `judge/readiness.js` also names WHY a book is unusable (`bookFreshDetail`) instead of `age nullms`.
- No change to thresholds, sizing, risk, gates, authority, order permissions or the paper runtime.

## 5. Socrates under the paper profile

- Case runtime: `desiredState ON` (`config/paper-runtime.json` groups.socrates.caseRuntime); it runs inside the market
  research service and seals cases under `<researchRoot>/cases/`.
- Model: `DISABLED_BY_PAPER_POLICY` — `config/market-research.paper.json` `model.enabled=false` with zero USD caps. A key in
  the environment never enables it; a case without a model seals `BUDGET_BLOCKED` (fail-closed). Enabling it is an operator
  policy change with explicit per-case / per-day caps, never an inference.
- Authority: `SEALED_CASE_INPUT_ONLY`. The Judge reads COMPLETED, byte-verified cases (law 5); Socrates output is
  interpretation, never source truth, never an order, never a threshold.
- The two dark families (Kraken Charts, Kraken L3) are OUTSIDE the decision registries and cannot reach Socrates, the
  Judge, Watch or execution (`test/market-kraken-edge-fences.test.js` F-03).
