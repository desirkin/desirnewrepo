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
judge/*.js       8702f68ebeeb27ff8671daa0d13c0df2b3af566890d13210f5b632fd0d3cdf89
execution/*.js   dd321ce97e24f21eb1bec9bb515a3729b07ac8ba50761a432fc7eceb0b05d6cc
watch/watch.js   0c6a43bf1eada1168d8fe074848e000210e1829eb9dff5a13b61f28685209f06
all (48 files)   43669403af154bb18499a5994fe6f98c662b10ccb5db0134e7c9fb058237369e
```

### 4.8 Audited change — 2026-09-15 Ticket 4 exit law: no live target; the D4 experiment flipped (previous digests: judge `638038da03d8…`, watch `be41c4bed1ce…`, all `345b28be7c89…`; execution `dd321ce9…` UNCHANGED)

Scope: `watch/watch.js` and the frozen experiment framework (`judge/challengers.js`, `judge/experiment-replay.js`). No decision, permission, sizing or reducer law changed; `entryPermission()` and the reducer are untouched; the paper profile still forces `JUDGE_MODE=PAPER` / no private / no orders.

David's decision (PHILOSOPHY.md, Decided doctrine): the live exit law has **no target price or percent anywhere**. A position rides until its ENTRY THESIS is invalidated (thesis falsification, flow/liquidity deterioration, edge-state decay), its protective stop or 1R trail is crossed, or a backstop timer fires; the 180 s no-progress and 4 h max timers are backstops, not the exit; the protective stop (native / structural / trail) is kept.

- `watch/watch.js`: `plannedTargetEnabled` now defaults to **OFF** (`exitPolicy?.plannedTarget === true`) — the live PAPER path (no exitPolicy) never takes a planned target and computes no target basis. The planned full exit at the frozen scenario target is RETAINED only as an opt-in research counterfactual carried by a REPLAY experiment arm. `finalizeR` computes the target basis only under the opt-in; a new `lazyTargetBasis` derives the in-memory basis for an already-FINAL position under the opt-in (a restored position, or the experiment's matched clone that begins after its reference's R was FINAL) without re-committing POSITION_R. `PLANNED_TARGET` stays a valid `execution/contract.js` EXIT_REASON (replay/restore of an in-flight exit and the experiment fixtures depend on it — execution/ is byte-unchanged).
- The D4 experiment is FLIPPED (`judge/experiment-replay.js`): `D4_EXIT_POLICY` is now `{ plannedTarget: true }`; the REFERENCE arms (no explicit exitPolicy) run the live no-target law; the D4 arm is the counterfactual that ENABLES the planned target, measuring whether adding it helps against the live no-target reference. The `D4_TRAIL_CONTINUATION_*` arms are renamed `D4_PLANNED_TARGET_*` (name follows meaning) across `judge/challengers.js`, `judge/experiment-replay.js`, the policy/config samples and docs.

Proof: `test/judge-watch.test.js` W01/W06 (the live law never takes a target; rides past the scenario target; the opt-in counterfactual still exits at the target), `test/judge-watch-escalation-review.test.js`, `test/judge-repair-restart.test.js` (target basis durable under the opt-in), `test/judge-experiment-replay.test.js` S01/S04 (REF = no-target, D4 = with-target on the same entry), and the full suite green at this commit.

### 4.7 Audited change — 2026-09-14 runtime unification step 3: fly.js onto the spine (frozen digests UNCHANGED)

Scope: the composition root only. `judge/`, `execution/` and `watch/watch.js` are byte-identical — the digests above did
not move — and `judge/composition.js` is untouched. fly.js is the root, not a frozen tree.

- `fly.js` derives `SERPENT_MODE` fail-closed (DATA_ONLY iff the data-only launcher pinned `SERPENT_DATA_ONLY`; PAPER iff
  `COBRA_PROFILE` is present AND every forced authority name holds — `JUDGE_MODE=PAPER`, `JUDGE_ALLOW_PRIVATE=false`,
  `JUDGE_ALLOW_ORDERS=false`; anything else exits 1 before composing anything: `test/serpent-mode-law.test.js`).
  DATA_ONLY delegates to the step-2 spine. PAPER runs today's sequence on the spine: the single-instance runtime lock is
  taken FIRST (a second instance on the same data dir refuses in either mode), then `startPersistence` (signals now owned
  by the runtime, `registerSignals: false`), the external-quota restore, and — new to the ship — the collector additions
  (market catalogs, broad Kraken capture, public discovery; `lib/collectors.js startPaperCollectorAdditions`, authority
  NONE, own transports and durable quotas). The Tape remains the signal owner; the spine's ordered stop (additions in
  reverse, checkpoints closed, persistence stopped, lock released) runs after the tape drains and after the Judge, the
  research service and the paper seam have stopped — so the DB is alive for every drain that needs it.
- What did NOT change: the Judge composition call and everything passed to it, `entryPermission()` and its call sites,
  the paper profile's forced names, the RUMOR-2 wiring (strainer, catalog source, Childhood bridge — byte-identical in
  fly.js), press/infra/video/gateway/wide-eye/governance/rumint starts, the learning opt-in, the cockpit order
  (PERSIST-0A §2 holds: the runtime establishes the persistence bootstrap before `ui/server.js` listens).

Proof: `test/serpent-paper-spine.test.js` PR-1..3 (injected starters: restore order, exact addition set and options, no
spine signals in PAPER, reverse stop, one-lock law both modes, fail-closed restore), `test/serpent-mode-law.test.js`
MODE-1..3 (spawned refusals before any write), and the untouched P-0x / fence suites; full suite green at this commit.

### 4.6 Audited change — 2026-09-14 lean trim step 1: one bankroll, one daily-lock law (previous digests: judge `b0f322af5648…`, execution `9e03f82702ce…`, all `5a36c0ebc96f…`, 47 files; watch/watch.js unchanged)

Scope: two files. No decision, sizing, permission, exit or risk law changed; the Judge's admission path is untouched.

- `execution/ledger-view.js` (new, pure): `ledgerView(state, { nowMs })` derives the cockpit ledger summary — closed trades with
  entry/exit/fees/realized P&L and close reason, open positions with the Watch's conservative mark, session P&L, win rate, profit
  factor, exit-reason census — from the reduced execution-journal state. Exact decimals in, display numbers out at this edge only.
  It is read by nothing in the decision path.
- `judge/composition.js`: the projection now publishes `dailyLock` (the journal's session P&L against opening equity under
  `config.locks` — the SAME `lockLevelForPnlPct` law `lockLevel()` already consulted in-process) and `ledger` (the view above).
  `composeJudge` gains one import; nothing passed to `createJudge` changed.

Why: the legacy JSONL ledger (`ledger/`, now `attic/ledger/`) computed a SECOND daily-lock answer from CLI-written files the
running app never wrote, so the cockpit could show "no lock" while the Judge refused. `state/locks.js dailyLockStatus()` now reads
`dailyLock` from the projection (or the simulated-P&L drill file); with no projection it reports level NONE, `source:
NO_PROJECTION`, and no fabricated P&L. The persistence pump no longer mirrors `ledger/*.jsonl`; `serpent_ledger_*` tables remain by
the additive migration law and are unused. `cobra ledger …` / `cobra rollup` are gone; `cobra status` reads the projection.

Proof: suite green after the change (see the commit); `test/judge-reservation-settlement.test.js`, `test/judge-e2e-preservation.test.js`
and the Judge differential (ea3bfbf Judge == working-tree Judge, ports absent) unchanged and passing.

### 4.5 Audited change — 2026-09-14 release-acceptance assembly + reservation settlement (previous digests: judge `58f04c37a1b5…`, execution `d9ce90d9b089…`, watch `dc49a39444e2…`, all `de596a965640…`, 41 files)

Scope: 27 commits between GitHub `main` (`ea3bfbf`) and `serpent/baseline` (`cbe2de5`) touched the frozen set — 24 files, +3,380 / −128 lines, six new `judge/` modules. These are the isolated repairs assembled into `codex/release-acceptance-20260914` on 2026-09-14 plus one dispatcher fix found by the full read-through. None of them had updated this section: the P-08 fence was red from the Replit patch series onward and stayed red because only focused files were ever run. This entry records the audit performed before re-pinning.

What changed, by law:

- **Five strategy families / edge-state exits** (`c3798ee`, `a659649`, `1aa979c`, `9affa73`): `judge/edge-state.js`, `judge/setup-selection.js`, `judge/size-ladder.js` added; `judge/setups.js`, `judge/policy.js`, `judge/judge.js`, `watch/watch.js` extended. Momentum and Micro-Bite become operational PAPER setups behind an explicit opt-in policy; Watch gains versioned edge-state exit reasons (`EDGE_STATE_UNKNOWN`, `EDGE_DECAY`, `DISTRIBUTION_EXHAUSTION`). Entry-time management versions are preserved across policy rollback. Catalyst evidence (exact crossing-time event/price) is frozen through confirmation and cannot be substituted later. Default policy unchanged.
- **Learning intake and adaptive ranking hook** (`b775d05`, `33a06f0`, `c695632`, `893e92f`, `c70d103`, `d4986c2`, `f4c23d7`, `1ab37fa`, `c76feac`): `judge/learning-intake.js`, `judge/learning-recipe.js`, `judge/learning-snapshot-cache.js`, `judge/adaptive-facts-source.js`, `judge/adaptive-ranking-port.js` added. The Judge accepts a dormant-by-default adaptive ranking port whose only permitted effect is a bounded rank offset (`ADAPTIVE_EFFECT_REGISTRY.RANKING_SELECTION`); entry, exit and sizing remain `UNSUPPORTED`. Lossy fact inputs are rejected; the sidecar market identity is bound; escaped JSON is bounded before serialization. Any invalid or absent port input resolves to pure baseline. `composeJudge` passes no port today, so the running Judge is byte-for-byte the baseline decision path.
- **Input history identity** (`ea26d03`): `judge/history.js` preserves exact Kraken pair identity, actual candle availability, and refuses falsely early live-bar closure.
- **Account / input bindings** (`42edffe`): XBT/XDG alias mapping, PAPER policy-digest gate, non-QUOTE fee-mode refusal.
- **Queue / canary / closeout integrity** (`4ff852e`, `c1b008f`, `5aa531d`, `f8525d6`, `a1d1396`, `167aa2c`, `e4dcf27`): zero-attempt entries recover after queue refusal; canary completion requires a dispatch attempt; unexecuted shells are excluded from trade evidence; executed closes with unknown outcomes are classified; composed ARM is guarded on persistence integrity; the CLI is bound to the persistence lifecycle; entry-only integrity gates (store guard) are added — unactivated.
- **Reservation settlement** (`cbe2de5`, `execution/dispatcher.js`): a normally FILLED / EXPIRED / CANCELLED paper entry now settles its `RESERVATION_OPENED` hold exactly once when the venue reports the order terminal. Before this, the hold stayed OPEN forever after a fill: on a USD 500 account, cash 65.96 but availableCash −368.27 after one trade; the asset stayed held after FLAT and the slot never returned. Reproduced through the real Judge → dispatcher → paper adapter → Watch path (`test/judge-reservation-settlement.test.js`). The release math is the pre-existing `settleReservation` law; no reducer rule changed.

Laws re-proved on the assembled tree (serial, offline guard, real PostgreSQL 16): 3,076 tests, 3,066 pass, 0 cancelled, 0 outbound attempts. `entryPermission()` remains the single permission law and is still evaluated pre-commit and twice pre-send. The paper profile still forces `JUDGE_MODE=PAPER`, `JUDGE_ALLOW_ORDERS=false`, `JUDGE_ALLOW_PRIVATE=false`. No LIVE path, threshold, or dark-Kraken authority changed.

### 4.4 Audited change — 2026-09-13 fail-closed learning and sizing review (previous digests: judge `c8e48d5c10b5...`, all `f9487cccf92f...`; execution/ and watch/watch.js still byte-identical)

Configuration baseline correction: commit `db4b1a2` already carried the operator's
`paper.baseBalanceUsd: 500` before this review (exact `cobra.config.json` SHA-256
`687d136747ee1292cbcfec6c4ac57ddcc322499696d65e9ab3cd90b087c61d87`). The two
closeout byte fences now protect that committed configuration instead of the stale
pre-`db4b1a2` $100 digest. This correction does not edit configuration, runtime state,
execution, Watch, or trading authority.

The package fence likewise now protects the already-authorized data-only entrypoints
(`data:only`, `data:only-ui`, and `data:status`) at exact `package.json` SHA-256
`22868ac835d3be284b6cb3a63703b27c92c04a2bcf4301b360511fb5ff3208d8`. No dependency
changed: `package-lock.json` remains exactly
`85ade4bd1ce094c37c89574a0adbe4e057e7d1a39358c45dcc3336925ee4ac6e`.

This review repaired reproduced integrity and bounded-record defects in the dormant learning/sizing path. It does not
claim model quality, profitable behavior, paper readiness, or complete validation. Both ports remain null-default and
unwired in `fly.js`; no threshold, risk cap, admission rule, entry permission, execution path, Watch rule, or LIVE
authority changed.

- `judge/learning-intake.js` + `judge/judge.js` — the consumer now requires the exact decision-view provenance,
  non-future prepared clock, explicit feature-recipe and policy versions, finite prepared values, non-negative fact ages,
  and every applicability feature. Corrupt/withheld records and conflicting versions fail to baseline with the affected
  candidates logged; no default version or zero-age value is invented.
- `judge/size-ladder.js` (`judge-size-ladder-4`) — fraction inputs are exact-decimal canonicalized, aliases cannot evade
  the all-in prerequisites, duplicates/malformed/count-over-limit inputs fail closed, and admission callback faults refuse
  only that candidate. Future books and negative freshness laws fail closed. The sustainability boundary uses exact decimal
  cross-products, while its percentage remains display-only. The deepest protective-exit proof is independently priced at
  the stop-stress mid with 25% recorded depth; target-exit sensitivity is not mislabelled as stop protection.
- The maximum ladder is 16 candidates. The largest existing setup contributes 13 clauses; the learning side contributes
  at most 24 candidate rows plus one summary; sizing contributes 16 rows plus one summary: `13 + 24 + 1 + 16 + 1 = 55`.
  This stays inside the unchanged 64-measurement contract, so the final decision slice cannot silently discard an allowed
  size row while its summary claims complete logging. Default fractions remain `0.25/0.5/0.75/1`.
- Companion learning producers now bind published activations to canonical design/evidence/terminal digests, re-derive that
  provenance in the decision view, leave a premature formal look pending without consuming the candidate, freeze the
  formal estimate to the first predeclared groups, and reject backdated or forged terminals. The portable JSON replacement
  path retains file-fsync/rename failure visibility while tolerating only Windows' unsupported directory-fsync `EPERM`.
- Focused regressions: `test/judge-sizing-review.test.js`, `test/judge-learning-intake.test.js`,
  `test/judge-e2e-preservation.test.js`, `test/learning-adapter-review.test.js`,
  `test/learning-prospective-terminal-regression.test.js`, and `test/jsonl-atomic-portable.test.js`. The differential and
  integrity-boundary tests continue to require the default-off Judge to match the archived baseline and forbid execution or
  Watch imports. Digest proof is still `test/paper-runtime.test.js` P-08.

### 4.3 Audited change — 2026-09-13 independent-review corrections (previous digests: judge `767bb48158ad…`, all `9012dd402d57…`; execution/ and watch/watch.js still byte-identical to the paper audit)

The dormant ports from §4.2 were completed per the independent review, still null-default and still unwired in
`fly.js`. Differential proof: `test/judge-differential.test.js` runs the ACTUAL `ea3bfbf` Judge (git archive)
beside this tree on identical recorded inputs and requires raw deepEqual over complete decisions, refusals and
account/execution state — passing, with zero normalizations.

- `judge/learning-intake.js` — the selector now matches the COMPLETED candidate contract: asset/venue scope
  lists (set membership, no name preference), mandatory eligibility envelope (liquidity + volatility ranges,
  requiredFeatures, maxFactAgeMs freshness), featureRecipeVersion/policyVersion pinning; every candidate seen
  is durably logged (`LEARNED_CANDIDATE` measurement rows). Still RANKING-only, bounded, baseline on any gap.
- `judge/size-ladder.js` (`judge-size-ladder-2`) — sustainable objective (net-return degradation tolerance
  anchored to the best smaller supported size); per-size records (entry/exit, fees, spread/slippage, net
  return %, stressed loss, reward/risk, depth-haircut exit sensitivities, admission verdict, opportunity
  cost); full-balance prerequisites (admission law, declared candidate max size, freshness, fresh book,
  protective exit at the deepest haircut) — any gap ⇒ conservative smaller-size fallback, recorded by name.
- `judge/judge.js` — the dynamic-sizing branch passes prepared inputs built ONLY from what the decision
  already holds (the unchanged admitCandidate per size, policy freshness, the validated candidate's declared
  maxSizeUsd or null); learned facts gain asset/venue/atrPct/ageMs. Ports still `null` by default; with both
  absent the differential proof above holds. No threshold, gate, authority, order permission, admission rule
  or risk rule was modified; sizing with the switch OFF is the exact §4.2 path.

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
