# JUDGE · WATCH · EXECUTION — owner reference and acceptance record

One vertical slice: research intake → evidence-bound decisions → portfolio sizing / reservations → PAPER and real
KRAKEN SPOT execution adapters → immediate position watching → restart / reconciliation → owner controls → an honest
evaluation report. Everything here is a PAPER_REFERENCE hypothesis for a USD 500 experiment. Nothing in this document,
the code, the policy or the fixtures states a desired return, a required win rate, a daily profit, a trade quota or a
loss-recovery quota. NO_TRADE is a successful decision. Zero trades is a valid experiment result.

Default startup of the ship is unchanged and non-trading: without `JUDGE_ENABLED=true` (fly.js) or an explicit
`bin/judge.js` invocation with a policy, an account and a mode, no execution module is constructed, no account exists,
no order can be formed. The real Kraken adapter is a working implementation exercised ONLY against loopback transport
doubles with synthetic credentials; live preflight, the canary and arming were NOT RUN in this build.

## Modules

| Path | Role |
|---|---|
| `execution/contract.js` | closed vocabularies, instrument spec, fee contract, book / trade schemas, event schemas, content-bound event ids, strict JSON |
| `execution/money.js` | exact BigInt decimals (canonical strings, explicit scale + directional rounding, 18-decimal bound) |
| `execution/reducer.js` | the ONE account reducer: price-blind law, reservations inside USD 500 including fees, entry form, fills / conservation, protection, R, restrictions, modes, authorization, valuation / drawdown latches |
| `execution/journal.js` | memory journal (REPLAY / OBSERVE / tests) and the PostgreSQL journal authority (writer epochs on the session lock, revision-checked append, pages, chain replay, venue LIVE owner slot) |
| `execution/clock.js` | permission clock: anchor + monotonic, server-time qualification, rollback / jump / expiry laws |
| `execution/feed.js` | the execution feed: exact lexemes, CRC-verified books, epochs / receipt sequences, bounded prioritized admission, pins, health / coverage |
| `execution/fees.js` | fee charges per scope, worst bounds, mismatch detection |
| `execution/adapter-contract.js` | normalized adapter events shared by both adapters |
| `execution/paper-adapter.js` | PAPER: first post-arrival book, per-level displayed-depth depletion, IOC remainder, emulated child stop, scripted faults |
| `execution/kraken-adapter.js` | KRAKEN SPOT: endpoint allowlist (no withdrawal / transfer / margin / staking), published signature vector, durable serialized nonce, IOC limit + conditional close, amend, cancel, residual close, paginated reconciliation, WebSocket v2 executions channel |
| `execution/dispatcher.js` | durable outbox → wire → result, prioritized safety / entry queues, adapter event mapping, restart reconciliation, latency samples |
| `execution/authority.js` | the ONE entry-authority law (`entryPermission`, `entryAuthority` before the commit and again immediately before the send) and the owned-reduction law (`reductionAuthority`) shared by Judge, dispatcher and Watch |
| `judge/snapshot-store.js` | bounded persisted decision / exit book snapshots (digest-named, atomic) written BEFORE the durable intent / the sale |
| `judge/case-verify-worker.js` | sealed-case verification in a worker thread (bounded, off the safety loop) |
| `judge/*` | features / setups / cost / risk (§4–§6), intake (sealed cases, catalyst taxonomy, control-field refusal), scheduler (25ms buckets), readiness, policy, judge, challengers / evaluation, arming, owner intent, composition, commands, history, case source, recorder, replay clock |
| `watch/watch.js` | exposure-first Watch: R finalization, deterioration, trail, targets, no-progress / duration, health halts, serialized exit coordinator, dust |
| `bin/judge.js` | the ONE CLI (closed subcommands, strict flags, secrets never as flags) |
| `state/execution-projection.js`, `state/machine.js`, `state/posture.js` | STRIKE / DIGESTING projected ONLY from a FRESH projection written from the journal; stale exposure is a RETREAT cause, never a flat fiction |
| `ui/server.js`, `ui/auth.js`, `ui/index.html` | read-only `/api/judge` view + drawer (PAPER prominent), the authenticated `POST /api/judge/arm` door |
| `persistence/schema.js` | additive migration 8 (`serpent_execution_accounts`, `serpent_execution_events`, `serpent_execution_writer_epoch`, `serpent_execution_live_owner`); versions 1–7 untouched |
| `market-lab/*`, `evidence/research-builder.js` | the four Santiment large-transfer metrics on their native 5m interval (registry → owner → provider → observation → context → packet → broker) |

## Owner files

| File | Sample | Notes |
|---|---|---|
| judge policy | `judge/samples/policy.paper-reference.json` | PAPER, USD 500, sample limits (3 slots / 1% per position / 2% aggregate / 1.5% cluster / 5% day / 10% peak), synthetic 0.8% ORDER_TOTAL taker reference fee, execution parameters, 13 evaluation arms, predeclared splits, `live: null` |
| LIVE policy | none shipped | `mode: LIVE`, `execution.adapter: KRAKEN`, `live.keyEnv` / `live.secretEnv` are environment variable NAMES; `live.ownerLimits` may stay `null` (then every arm needs `--owner-limits FILE`); `live.armExpiryMs` bounds the owner's expiry |
| owner limits | — | a LIMITS-shaped JSON the owner writes for the arm (never the paper sample by default) |
| release manifest / approval | `prepare-release --out` / `approve-release` | durable records under `<data dir>/execution/approvals/` |

The policy validator refuses any performance-promise wording, a LIVE policy without the KRAKEN adapter or the live
section, a paper policy with the KRAKEN adapter, splits that do not sum to 1. `cobra.config.json` is untouched.

## Commands (exact)

```
node bin/judge.js inspect          --policy P [--account A]
node bin/judge.js run-observe      --policy P [--pairs XBT/USD,SOL/USD] [--record DIR] [--minutes N]
node bin/judge.js init-paper       --policy P [--account A] --owner-stdin true
node bin/judge.js replay           --policy P --recording DIR [--pairs ..] [--specs FILE] [--out FILE]
node bin/judge.js replay-experiment --policy P --bundle DIR --experiment ID [--arms A,B] [--seed S] [--stop-at-seq N] [--expect-policy-binding true] [--out FILE]
node bin/judge.js declare-experiment --policy P --experiment ID --start 2026-10-01T00:00:00Z --duration-ms N --owner-stdin true [--development-fraction F] [--validation-fraction F] [--embargo-ms N] [--lookback-ms N] [--decision-ms N] [--max-outcome-ms N] [--publication-floor-ms N] [--arms ..] [--seed S] [--source-prefix P] [--exploratory true]
node bin/judge.js evaluate-experiment --policy P --experiment ID --report FILE --split DEVELOPMENT|VALIDATION [--out FILE]
node bin/judge.js lock-candidate   --policy P --experiment ID --arm ARM --owner-stdin true
node bin/judge.js open-holdout     --policy P --experiment ID --run-id ID --report FILE --owner-stdin true [--out FILE]
node bin/judge.js verify           [--bundle DIR] [--experiment ID] [--manifest FILE --experiment ID] (in addition to the existing --policy/--account/--case/--recording/--approval)
node bin/judge.js prepare-release  --policy P --experiment ID ... (the holdout chain is read from the experiment store; without --experiment the candidate is BLOCKED: HOLDOUT_CHAIN_MISSING)
node bin/judge.js run-paper        --policy P --account A --owner-stdin true [--pairs ..] [--cases DIR] [--record DIR]
node bin/judge.js preflight-live   --policy P --account A --owner-stdin true --allow-private true
node bin/judge.js arm-live         --policy P --account A --approval FILE --allocation-ceiling USD --owner-stdin true --challenge true
node bin/judge.js arm-live         --policy P --account A --approval FILE --allocation-ceiling USD --owner-stdin true --confirm true --expires-at UTC --owner-limits FILE [--preflight FILE]
node bin/judge.js run-live         --policy P --account A --owner-stdin true --allow-private true [--pairs ..]
node bin/judge.js canary-live      --policy P --account A --owner-stdin true --allow-private true
node bin/judge.js prepare-release  --policy P [--account A] [--out FILE] [--evaluation FILE] [--tests-evidence FILE] [--review PASSED --reviewer X] [--proposed-limits FILE]
node bin/judge.js approve-release  --manifest FILE --manifest-digest HEX --assessment FILE --owner-stdin true
node bin/judge.js cage | kill      --owner-stdin true         node bin/judge.js veto --prediction-id ID --owner-stdin true
node bin/judge.js reconcile        --policy P --account A --owner-stdin true [--allow-private true]
node bin/judge.js status [--policy P --account A]   evaluate --policy P --account A [--out FILE]   verify [--policy P] [--case DIR] [--recording DIR] [--manifest FILE] [--approval FILE]
```

Owner intent: mutating commands read the configured control password (`SERPENT_CONTROL_PASSWORD`) from stdin
(`--owner-stdin true`, first line) or from `JUDGE_OWNER_PASSWORD`; never a flag (`--password`, `--secret`, `--key`
are refused by the parser). Each attempt is audited to `<data dir>/execution/owner_audit.jsonl` without the secret.
The arm confirmation reads two stdin lines: the password, then the exact server-generated phrase
(`ARM LIVE <account> <ceiling> <policy digest prefix> <nonce>`, 120 s TTL, consumed by the first attempt). Trade
credentials come only from the environment names the LIVE policy declares, only in LIVE modes; the CLI, the cockpit,
the projection, the audit and the journal persist a key fingerprint at most.

Exit codes: 0 ok · 2 invalid request · 3 corrupt input · 4 resource (no database, no transport) · 5 failure · 6
refused (owner intent, policy, binding).

### fly.js opt-in

`JUDGE_ENABLED=true JUDGE_POLICY=<file> JUDGE_MODE=OBSERVE|PAPER|LIVE_UNARMED|LIVE_ARMED [JUDGE_ACCOUNT=<id>]
[JUDGE_RECORD_DIR=<dir>] [JUDGE_ALLOW_PRIVATE=true] [JUDGE_ALLOW_ORDERS=true]`. The composition receives the Tape's
accepted public messages through the execution-feed seam (no duplicate collector), reads sealed cases from the research
root read-only, publishes `<data dir>/execution/projection.json`, and registers with the cockpit so `POST /api/judge/arm`
binds to the actual account. PAPER / LIVE need `DATABASE_URL` (the journal authority) and an owner-initialized account.
Do not run `bin/judge.js run-*` beside a JUDGE-enabled fly.js on the same account: the writer lock refuses the second.

### The paper path, in order

1. `init-paper` (owner intent; refuses to reset an existing account; no implicit deposit on restart).
2. `run-paper` (or fly.js with `JUDGE_MODE=PAPER`) with `--record DIR` to keep the exact feed bytes.
3. `status` / cockpit JUDGE drawer: candidates, readiness rows, refusal clauses, held quantity / protection, drawdown.
4. `evaluate --out FILE`: per-arm metrics with denominators, splits, experience ledger, `UNVALIDATED_HYPOTHESIS`.
5. `replay --recording DIR`: the same recording, policy, seed and code yield the same decisions and state digest.

### The live path, in order (NOT RUN in this build)

1. A LIVE policy + a dedicated trade key (spot trading only, NO withdrawal permission) in the named environment variables.
2. `prepare-release` → a CANDIDATE manifest needs forward-paper evidence (source `FORWARD_PAPER`, a non-empty closed
   sample, a KNOWN net P&L, an evaluation digest, untouched holdout, fees accounted, no open positions), non-empty
   source prefixes, passing critical suites, an independent review PASSED, proposed limits; otherwise BLOCKED with named
   blockers. The blockers FOLLOW from the content (`releaseBlockers`): a manifest whose state / blockers do not follow
   is `MANIFEST_INVALID` for generation, reopen, approval and arm alike (rehashing is integrity, never qualification).
   The `evaluate` artifact (`--out`) carries `release`, `evaluationDigest` and `sourcePrefixes` for `--evaluation`; its
   `holdoutUntouched` is `false` because the evaluation examined every split — it never qualifies alone.
3. `approve-release` (owner intent; bounded written assessment that states uncertainty) → durable approval; it grants
   eligibility for the remaining checks only.
4. `preflight-live --allow-private true` (owner intent): read-only private checks — server time, key permissions
   (redacted: fingerprint + allowlisted permission facts; the echoed key is never persisted), balance, open orders. Sends
   no order. Creates the LIVE journal account on first success.
5. `arm-live --challenge true` then `arm-live --confirm true --expires-at .. --owner-limits FILE --preflight FILE`:
   the authorization binds account / mode, venue, release / policy / code digests, allocation ceiling ≤ verified funds,
   reinvestment policy, every cap, key fingerprint, issuance / expiry (≤ `live.armExpiryMs`) and the restriction
   revision. `OWNER_LIMITS_REQUIRED` until the owner chooses limits. The ORDINARY arm additionally needs qualified canary
   evidence: a canary authorization on THIS account under the SAME release that ran ARMED, whose entry reached a terminal
   state with certainty, whose position is flat and whose shutdown reconciliation was COMPLETE (`CANARY_EVIDENCE_REQUIRED`
   otherwise, enforced by `buildLiveAuthorization` AND the reducer). The code identity must be known: a dirty worktree or
   an unknown tree yields no digest and `CODE_IDENTITY_UNKNOWN` (a running authorization ends on restart under an unknown
   identity). The arm challenge is consumed durably BEFORE it is verified (one attempt per phrase, right or wrong:
   `CHALLENGE_CONSUMED`); the owner-intent audit line is written BEFORE any authority (`AUDIT_UNWRITABLE` refuses); the
   failed-attempt limiter is a durable file (`owner_limiter.json`) — a fresh process is not a fresh allowance.
6. `run-live --allow-private true` (owner intent): claims the venue owner slot, reconciles, preflights again in-process,
   resumes the SAME unexpired authorization (mode → LIVE_ARMED), connects the private executions channel, runs the tape.
   A changed code / policy / key binding on restart ENDS the old authorization; exposure stays managed under its recorded
   safety policy. Expiry stops additions; owned exits / protection continue.
7. `canary-live` needs its OWN short-lived CANARY authorization (`arm-live --canary-pair .. --canary-max-consideration ..
   --canary-max-duration-ms .. --canary-loss-acknowledged true`): the CANARY authorization enters `LIVE_ARMED` (reducer
   `MODE_TRANSITION`), only `CANARY_ENTRY` intents on the authorized pair pass (`CANARY_PAIR` in the shared permission law,
   `CANARY_BOUNDS` in the reducer), the position duration is bounded by the canary, ordinary and canary authorizations are
   mutually exclusive on an account. A canary that ran ARMED and reconciled COMPLETE at stop ends `COMPLETED` (lifecycle
   `CANARY_COMPLETED`; `CANARY_INCOMPLETE:<reason>` otherwise) — the durable `canaryEvidence` step 5 requires. It costs
   fees and can lose money. It comes BEFORE the ordinary arm, never instead of it.

The cockpit door (`POST /api/judge/arm`, steps `challenge` / `confirm`) needs the session cookie, the CSRF header,
same origin, the FRESH password (limiter-governed), the exact phrase and the account / allocation / policy / release
binding; `GET` is 405; a payload naming another account is refused; nothing arms without a passed preflight in that
process. No cockpit button issues an arm.

## Limitations (honest)

- The Kraken adapter's wire behavior is verified against loopback doubles and the published signature vector. The
  executions-channel field names (`order_id`, `cl_ord_id`, `exec_id`, `exec_type`, `order_status`, `order_qty`,
  `cum_qty`, `last_qty`, `last_price`, `fees[]`, `ord_ref_id`, `triggers.price`, `sequence`) follow the reference notes
  because the documentation page returned 404 during this build: **review item** — confirm against a live private
  subscription before any live run. Any mismatch surfaces as `RECONCILIATION_REQUIRED`, never as a fill.
- A conditional close is NOT a combined bracket: the child stop exists only after the parent fills; the Watch treats
  the interval before `PROTECTION_STATE ACTIVE` as unprotected exposure (`PROTECTION_INVALID` after 2 s).
- PAPER fills are hypothetical: first accepted post-arrival book, displayed depth only, per-level depletion, no queue
  position, no hidden liquidity, emulated child stop (`PAPER_LIMITATION` label on every record). A simulated order never
  makes its input feed real; a fixture / replay run is labelled and can never become release evidence.
- `prepare-release` cannot prove by itself that a paper account ran on a forward feed; `--evaluation-source
  FORWARD_PAPER` is an owner assertion recorded in the manifest and reviewed independently.
- The evaluation report carries denominators, censoring and small-sample notes; `calibrationState` is
  `UNVALIDATED_HYPOTHESIS` everywhere. No fitted model or probability estimator exists.
- Bar history: a minute without an observed trade is a gap (never filled from a later bar); OHLC retrieval is
  receipt-floored and bounded (720 rows).
- Live owner slot, nonce store and writer epochs are per installation; two installations sharing one key are outside
  this build's guarantees.
- Native permission vocabulary (closeout R05): the `GetApiKeyInfo` documentation page returned 404 during this repair, so
  only the identifiers the ticket names — `query-funds`, `query-open-trades`, `modify-trades` — are KNOWN; nothing else
  is invented. The remaining capabilities are PROVEN by documented endpoint probes in preflight (`CancelOrder` with the
  synthetic txid `OPROBE-00000-000000` → `EOrder:Unknown order` proves cancel permission, `Permission denied` denies it;
  `ClosedOrders`; `GetWebSocketsToken`); an unproven capability is `CAPABILITY_<X>_NOT_PROVEN`. Available funds come from
  `BalanceEx` (`balance` − `hold_trade`), never from the gross balance.
- Book checksum (closeout R09): the feed's CRC32 is verified against the published documentation example (BTC/USD, ten
  asks / ten bids, checksum `3310070434`) — a real example, not a self-referential vector.
- Challenger verdicts (closeout R13): the production Judge records no per-decision challenger verdicts yet
  (`DECISION_RECORDED.verdicts` stays absent), so the D1 / D2 / D3 / ablation arms report `UNSCORABLE` with
  `NO_RECORDED_VERDICTS`; the setup arms, `REF_COMBINED`, `CASH` and the seeded control are SCORED from independent
  simulated accounts over the durable stream. The D4 exit-policy views need their own accounts (`UNSCORABLE` with reason).
- Code identity (closeout R14): `codeTreeDigest` is `null` on a dirty worktree (modified OR untracked files); a release
  prepared or an arm attempted from an uncommitted tree is refused (`CODE_TREE_DIGEST_MISSING`, `CODE_IDENTITY_UNKNOWN`).
- The canary path is exercised end to end against a SCRIPTED venue only (arming `R14-04`, section-d `D6`); no canary has
  run against the real venue in this build.

## Consistency review record (ticket §12, one deliberate pass)

nomination → sealed evidence → feature / decision → cost / size → durable reservation → pre-send revalidation → real wire
request → first partial fill → native protection → Watch → cancel / fill race → residual / dust → restart / reconcile →
P&L / limits → evaluation → owner arm / UI. Checked: copied identities (decision / episode / position / order / native
ids, exec ids, cl_ord_id ≤ 18), clocks (decisionKnownAtTs vs receipt vs source, expiry equality, monotonic durations),
amounts (reserved ≥ worst intent, decision limit / qty caps, per-unit target scale), permission transitions (LIVE_UNARMED
forbids even the reservation; LIVE_ARMED needs an active LIVE_ARM authorization named by the transition; canary bounds),
failure cleanup (rejection with guarantee releases the reservation; uncertain results stay uncertain; late fills book
against the protective order; a refused sell keeps the residual visible; stale projection → RETREAT cause).

Defects found and fixed during the review / end-to-end runs: the Watch's per-unit target used 12 decimals and overflowed
the exact bound on the residual product (now 8); authorization ids collided across kinds / arms at one clock (now bound
to kind, ceiling, expiry and revision); the projection file was refreshed only on a wall timer (now also after every
journal commit); the context builder bound the open 5m interval as a complete component (now only closed periods);
the reducer had no canary consideration / pair / count bound (added); the composition did not connect the private
executions channel on LIVE start (added).

Previously named uncovered cases, now closed by the R01–R16 closeout (`docs/JUDGE-CLOSEOUT-ACCEPTANCE.md`): (1) a late
adapter callback after `stop()` is fenced through the closed dispatcher (projection `R16-05`, counted, no commit, no
throw); (2) the executions-channel reconnect re-subscribes with a fresh token and reconciles the gap (runtime
`R15-03/R15-04`); (3) an unwritable projection / checkpoint / snapshot directory is a counted, reported failure that
never stops the run (projection `R16-05`), a recorder failure closes admission (evidence `R11-03`); (4) the canary run is
exercised end to end against a scripted venue (arming `R14-04`, section-d `D6`) — still never against the real venue.

## Traceability (acceptance id → tests → boundary)

Test files: `test/judge-money.test.js` (money), `test/judge-reducer.test.js` (reducer), `test/judge-feed-clock.test.js`
(feed/clock), `test/judge-adapters.test.js` (adapters), `test/judge-journal-pg.test.js` (PG journal),
`test/judge-cost-capital.test.js` (cost/capital + features/setups), `test/judge-watch.test.js` (watch),
`test/judge-decisions.test.js` (decisions), `test/judge-evaluation.test.js` (evaluation), `test/judge-whales.test.js`
(whales), `test/judge-arming.test.js` (arming/security/composition), `test/judge-composition.test.js` (composition,
history, recorder/replay, readiness), `test/judge-e2e-pg.test.js` (end-to-end over PostgreSQL). PG suites skip honestly
without `PERSIST_TEST_DATABASE_URL` / `DATABASE_URL`; the final gate ran them with the isolated loopback cluster.

| Id | Tests | Boundary |
|---|---|---|
| J01 | cost-capital `J01-features`, `J01-setups` (×2) | `judge/features.js`, `judge/setups.js` |
| J02 | decisions `J02/J10/J08`; e2e-pg `E2E-1` (PG), `E2E-2` (LIVE wire) | `judge/judge.js` through the composition |
| J03 | decisions `J09/J07/J03`, `J05/J11/J03` | `judge/intake.js` |
| J04 | decisions `J04/J08` | `judge/setups.js` episode tracker |
| J05 | decisions `J05/J11/J03` | readiness + intake |
| J06 | decisions `J06` | intake control-field refusal, `judge/contract.js` closed schema |
| J07 | decisions `J09/J07/J03` (invalid case rejected not stripped; catalyst needs a mapped primary event), `J05` | intake |
| J08 | decisions `J02/J10/J08`, `J04/J08` | frozen references, breach reset, 10 s expiry |
| J09 | decisions `J09/J07/J03`; e2e-pg `E2E-1` (COMPLETED + LIVE_MODEL provenance accepted without context requirement; RECORDED_RESPONSE refused in PAPER, admitted in REPLAY; missing recomputed context → not a context proof) | `judge/intake.js`, `judge/case-source.js` |
| J10 | decisions `J10`, `J02/J10/J08` | `judge/scheduler.js` |
| J11 | decisions `J05/J11/J03`; composition `J11` (slots / readiness) and `J11/E03` (composition slots, preemption release) | `judge/readiness.js`, `judge/composition.js` |
| J12 | cost-capital `J12/J01-flow` | `judge/features.js` flow tracker vs batch |
| C01 | cost-capital `C01/C08`; money `MONEY-03` | `judge/cost.js` synthetic oracle (−1.0048) |
| C02 | cost-capital `C02/C03/C04` | buffered reward gate |
| C03 | cost-capital `C02/C03/C04` | size-specific costs, depth exhaustion, minima, base fees |
| C04 | cost-capital `C02/C03/C04` | spread / slippage attribution once, stress mid |
| C05 | cost-capital `C06/C10` (`LIMIT_ABOVE_DECISION`, stale approval), decisions `J02` (revalidation via admission recheck) | reducer + judge recheck |
| C06 | cost-capital `C06/C10`; reducer `RED-02` | reservations inside USD 500 including fees |
| C07 | cost-capital `C07` | `judge/risk.js` clusters / admission |
| C08 | cost-capital `C01/C08`; watch `W03/W02` (loss-making protective exit permitted) | cost + watch |
| C09 | cost-capital `C09`; money `MONEY-04` | second price-bound oracle (+0.1996 / −0.1007) |
| C10 | cost-capital `C06/C10`; evaluation `P07/P10` (no double allocation to shadows) | risk budget / ranking |
| C11 | cost-capital `C11` | `execution/fees.js` scopes / mismatch |
| C12 | reducer `RED-06 (C12)` | flow-neutral drawdown, session allowance |
| D01 | journal-pg `D01` | migration 8 additive, 1–7 untouched |
| D02 | journal-pg `D02/D08` | transaction rollback before / after append |
| D03 | journal-pg `D03/D07`, `A09/D03` | writer race, revoked epoch |
| D04 | journal-pg `D04/D09`; e2e-pg `E2E-1`, `E2E-2` (restart) | outbox before wire, no resend |
| D05 | reducer `RED-04 (D05/D06/C06)` | duplicate vs conflicting exec identity, cum totals |
| D06 | reducer `RED-04`; e2e-pg `E2E-2` (late fill after cancellation booked against the protective order) | reducer late fills |
| D07 | journal-pg `D03/D07` | corrupt prefix / failed restore never flat |
| D08 | journal-pg `D02/D08` | bounded pages, oversized batch |
| D09 | journal-pg `D04/D09` | blocked venue wait holds no row lock; safety commit proceeds |
| E01 | adapters `E01` | published signature vector, nonce store |
| E02 | adapters `E02/E12`; e2e-pg `E2E-2` (exact AddOrder body from the live path) | REST payload |
| E03 | adapters `E03/A05`; composition `J11/E03` (OBSERVE: no credentials, PAPER adapter) | modes without private transport |
| E04 | adapters `E04/E11-native`; e2e-pg `E2E-2` (partial before status, contingent child) | executions records |
| E05 | adapters `E05/E10` | UNCERTAIN results stay uncertain |
| E06 | adapters `P02/E06/E07`; e2e-pg `E2E-2` (cancel acknowledged, stop fill arrives, refused second sell) | cancel / fill race |
| E07 | adapters `P02/E06/E07` | rejected / missing child, base fee, below-minimum residual |
| E08 | adapters `E12/E08`; e2e-pg `E2E-2` (known trades deduplicated on restart) | paginated reconciliation |
| E09 | journal-pg `D03/D07` (fence), watch `W10` (heartbeat under a blocked worker) — PARTIAL, see uncovered (1) | drain / fence |
| E10 | adapters `E05/E10`; feed/clock `E11-b` (epochs) — PARTIAL for WS re-subscription, see uncovered (2) | backoff / 429 / uncertainty |
| E11 | feed/clock `E11-a`, `E11-b`, `E11-c`; composition `P03/E11` | CRC, lexemes, epochs, snapshot labelling |
| E12 | adapters `E02/E12`, `E12/E08` | nonce serialization, key-info redaction |
| W01 | watch `W01/W09` | first partial fill tracked, safety outranks entry |
| W02 | watch `W02/W07`, `W03/W02` | KILL / CAGE / VETO precedence |
| W03 | watch `W03/W02` | hard stop, verified falsifier vs counter-rumor |
| W04 | watch `W04/W06`; e2e-pg `E2E-1`, `E2E-2` | deterioration law |
| W05 | watch `W05` | net-R trail, amend spacing |
| W06 | watch `W06`, `W04/W06` | no-progress / target / 4 h, no minimum hold |
| W07 | watch `W02/W07` | feed / DB failure halts |
| W08 | watch `W08`; reducer `RED-05`; e2e-pg `E2E-2` | dust / orphan / remainder before flat |
| W09 | watch `W01/W09` | 50% fill target, provisional vs final R, late fee correction |
| W10 | watch `W10` | slow worker cannot block the loop |
| P01 | adapters `P01` | first post-arrival book, bounded wait |
| P02 | adapters `P02/E06/E07` | depletion, partials, fee currency |
| P03 | evaluation `P03/P04/P05/P08`; composition `P03/E11`, `J11/E03` (same recording twice → same digest) | deterministic replay |
| P04 | evaluation `P03/P04/P05/P08` | chronological groups, purge, holdout |
| P05 | evaluation `P03/P04/P05/P08` | 13 arms, controls |
| P06 | evaluation `P06/P08` | empty / open-loss sample |
| P07 | evaluation `P07/P10` | D4 continuation, censoring |
| P08 | evaluation `P06/P08`; e2e-pg `E2E-1` (funnel from events) | funnel, no profitability seal |
| P09 | adapters `P09` | per-level depletion oracle |
| P10 | evaluation `P07/P10` | funded vs matched D4 |
| A01 | arming `A01/A08` | binding, paper sample cannot arm |
| A02 | arming `A02` (cockpit), `A02-cli/A08-cli` | owner limits / expiry / fresh password / CSRF / same-origin / no GET |
| A03 | arming `A03/A04/A09/A10` | keys alone deny; binding change ends authority |
| A04 | arming `A03/A04/A09/A10`; e2e-pg `E2E-2` | qualified restart resumes the same authorization |
| A05 | arming `A05/A06`; adapters `E03/A05` | allowlist, no secret serialization |
| A06 | arming `A05/A06`; `test/market-lab-fences.test.js`; `test/posture.test.js` | disabled default, fences both directions |
| A07 | arming `A07`; e2e-pg `E2E-1` | projection = cockpit = CLI = posture |
| A08 | arming `A01/A08`, `A02-cli/A08-cli` | release / approval separation, tampered evidence |
| A09 | journal-pg `A09/D03`; arming `A03/A04/A09/A10`; e2e-pg `E2E-2` | venue owner slot, canary exclusivity |
| A10 | feed/clock `A10-clock`; arming `A03/A04/A09/A10` (expiry equality) | clock laws |
| F01 | whales `F01` | four exact ids / units in every map |
| F02 | whales `F05/F02` | denied entitlement / delayed history, never a zero |
| F03 | evaluation `F03/D1`, `F03/D2` | exact windows, zero denominators |
| F04 | the full gate: `test/market-*`, `test/social-*`, `test/rumor2-*`, tape / control / ledger suites unchanged | regressions |
| F05 | whales `F05/F02` | 5m route end to end |
| F06 | evaluation `F06/D3` | peer membership by window start |

## Per-setup data requirements

| Setup | Mandatory (execution) | Optional |
|---|---|---|
| RANGE_IGNITION, TREND_PULLBACK_CONTINUATION | 61 complete 1m bars, 21 min continuous signed flow, fresh CRC-verified book, instrument spec, credible fee contract | sealed case (CASE_ENRICHED), whale metrics |
| ABSORPTION_RECLAIM | all of the above + 30 baseline books (depth median support) | sealed case, whale metrics |
| CATALYST_TRANSMISSION | all of the above + a COMPLETED / ANALYZED case with a recomputed context and a PRIMARY_CONFIRMED mapped event | whale metrics |

Absent optional data never forbids a market setup; a missing executable book or credible cost always does.

## Closeout R01–R16 traceability (this repair)

The independent-review closeout (`docs/JUDGE-CLOSEOUT-ACCEPTANCE.md`) carries one row per assertion with baseline /
candidate results and evidence-log locations. Test files: `test/judge-repair-authority.test.js` (R01),
`test/judge-repair-accounting.test.js` (R06), `test/judge-repair-exit.test.js` (R02/R04), `test/judge-repair-kraken.test.js`
(R03/R05), `test/judge-repair-restart.test.js` (R07), `test/judge-repair-runtime.test.js` (R08/R09/R15),
`test/judge-repair-evidence.test.js` (R10/R11), `test/judge-repair-evaluation.test.js` (R12/R13),
`test/judge-repair-arming.test.js` (R14), `test/judge-repair-projection.test.js` (R16), `test/judge-repair-pg.test.js`
(R01-07 / R15-01 / R16-04 over competing PostgreSQL sessions), `test/judge-repair-section-d.test.js` (D1–D6 over
PostgreSQL through the actual CLI / composition with scripted transports).

| Law | Production boundary |
|---|---|
| ONE entry-authority law before commit and again immediately before the send (R01) | `execution/authority.js` (`entryPermission`, `entryAuthority`, `reductionAuthority`) used by `judge/judge.js`, `execution/dispatcher.js`, `watch/watch.js` |
| cancel → confirm → reconcile → sell; protection as a SET of children (R02/R04) | `watch/watch.js` (phase `RECONCILING`), `execution/reducer.js` (`protection.children`, `deriveProtection`) |
| hydrate ownership, query open + closed orders, validated pages, durable dedup (R03) | `execution/kraken-adapter.js` (`hydrate`, `reconcile`, `paged`) |
| documented permission identifiers, probes, fixed WS host, available funds (R05) | `execution/kraken-adapter.js` (`KRAKEN_NATIVE_PERMISSIONS`, `PROBE_TXID`, `connectExecutions`, `BalanceEx`) |
| exact net basis, adjustment dedup, durable valuation, synchronized correlation (R06) | `execution/reducer.js` (`recomputeRealized`, adjustments), `judge/composition.js` (`publishValuation`), `judge/risk.js` |
| durable Watch / PAPER restart (R07) | `watch/watch.js` (`restoredExit`, `targetPerUnit`), `execution/paper-adapter.js` (`restore`), `judge/composition.js` (checkpoint) |
| clock qualification, scheduler independence, deterministic ranking, bounded queues, serialized ticks (R08) | `judge/composition.js` (`qualifyClock`, `SCHEDULER_TICK_MS`, `tick`), `judge/judge.js` (`admissionGate`), `execution/dispatcher.js` (`pumpSafety` / `pumpEntry`, `OVERLOAD`) |
| immutable exact-depth feed, real checksum example, specs via transport, coverage invalidation (R09) | `execution/feed.js`, `judge/composition.js` (`ensureSpecs`) |
| lawful v2 evidence normalization, production catalyst / correction delivery, whole-bundle cache key, absorption windows (R10) | `judge/intake.js` (`primaryConfirmedCatalyst`, `primaryCorrections`, `caseBytesKey`), `judge/composition.js` (`deliverEvidence`), `judge/setups.js` |
| sealed recordings, persisted snapshots, verify never complete for partial data (R11) | `judge/recorder.js` (manifest, `verifyRecording`), `judge/snapshot-store.js` |
| D1 displayed-depth stress, D3 target identity, D2 covered intervals (R12) | `judge/challengers.js` (`scaleDisplayedDepth`, `peerMembership.self`, `windowsCovered`) |
| independent simulated arms, durable splits, bounded pages, complete outcome reporting (R13) | `judge/challengers.js` (`evaluateArms`, `declareSplits`), `judge/commands.js` (`evaluate`) |
| shared manifest semantics, no null qualification, canary permission runs canary, canary evidence, code identity, durable audit / challenge / limiter (R14) | `judge/arming.js` (`releaseBlockers`, `manifestSemanticsError`, `buildLiveAuthorization`), `execution/reducer.js` (`canaryEvidence`, `COMPLETED`), `judge/owner.js`, `judge/composition.js` (`stop`) |
| one lifecycle law, atomic slot, release after handoff, reconnect + reconcile (R15) | `judge/composition.js` (`start` / `stop`), `execution/journal.js` (live owner), `execution/kraken-adapter.js` (`connectExecutions`) |
| bounded checkpoints, owned base in the projection, bound projection, restore failure, fenced late callbacks, file failures (R16) | `judge/composition.js` (`projection`, `publishProjection`), `state/execution-projection.js`, `ui/server.js` (`judgeView`), `state/machine.js` |

## Focused completion (revision 2, 2026-09-09) — offline research over recorded inputs

Everything in this section is offline code over recorded inputs. It authorizes no activation, no provider / model / exchange
call, no paper deployment and no order. `READY_FOR_INDEPENDENT_REVIEW` for this delivery means the offline assertions below
hold under the enforced guard; it does not mean paper operation or trading is verified.

### The offline guard and the gate (N01 / N02)

`test/helpers/offline-guard.mjs` is preloaded into every test process and every spawned Node child
(`NODE_OPTIONS="--import=$PWD/test/helpers/offline-guard.mjs"`; children with replaced env objects are re-armed by the wrapped
`child_process` API). It denies every non-loopback route BEFORE the transport opens — `fetch`, `WebSocket`, `net` / `tls`
sockets, DNS lookups / resolves and datagrams — and appends one evidence record per attempt (kind, host, port, pid, run
identity, test file, three stack frames; never a URL query, body, header or key) to a JSONL file OUTSIDE the tree
(`COBRA_OFFLINE_GUARD_LOG`, default under the OS temp dir). Loopback HTTP / PostgreSQL behave normally. The guard's own
self-tests run in separate processes with an explicit `selftest:<name>:<uuid>` run identity and assert the exact expected
denial records; nothing else is exempt, by file name or otherwise. The gate:

```
NODE_OPTIONS="--import=$PWD/test/helpers/offline-guard.mjs" COBRA_OFFLINE_GUARD_LOG=/tmp/guard.jsonl COBRA_OFFLINE_GUARD_RUN=suite \
PERSIST_TEST_DATABASE_URL=postgresql://... node --test --test-concurrency=1
node tools/offline-gate.mjs /tmp/guard.jsonl      # exit 1 when ANY non-selftest attempt was denied, even one the application caught
```

The reviewer's 14 (guarded baseline with PostgreSQL: 19) external WebSocket attempts came from LIVE compositions in
`judge-arming`, `judge-repair-arming`, `judge-repair-kraken`, `judge-repair-runtime`, `judge-e2e-pg` and `judge-repair-pg`
that omitted a WebSocket double, so `composeJudge` fell back to the process `WebSocket` and the real adapter opened
`wss://ws-auth.kraken.com/v2`. Every such composition now receives `test/helpers/scripted-ws.js` — a scripted
executions-channel venue (open, subscribe with the token, acknowledgement, sequenced executions and gaps, ping / pong, a
venue-side drop with reconnect and a fresh token, the owner's close). The production adapter is unchanged.

### The experiment input bundle (I01–I03)

A recording made with `--record DIR` is now an input bundle: beside the exact feed rows the recorder writes typed rows —
NOMINATION (as discovered, with its known-at), INSTRUMENT, FEE, HISTORY (the exact OHLC rows retrieved, their receipt clock and
the provider's last committed bar), CASE (a consumed verified case: packet, selected analysis, the verifier's output with its
digest, provenance re-derived from the verifier), CONTROL (every change) and, when supplied by research configuration, WHALE
/ PEER. Every row carries one capture sequence; the manifest carries `bundleVersion`, per-kind `capabilities`, the
experiment `binding` and the replay `tieOrderVersion`. Typed rows are validated by closed schemas BEFORE they are written
(an invalid row INTERRUPTS the recording with the reason — never a silent strip), at reopen and at the evaluation APIs;
identities (instrument / fee digests, packet and analysis ids, verification digest) are re-derived, never trusted as copied.
Legacy raw-only recordings stay readable and replayable through the legacy `replay`; `replayCapabilities` names what they
lack (raw-feed COMPLETE is not "inputs exist"). Bounds are explicit: per-kind record bounds interrupt the recording naming
the bound, the bundle stores refuse beyond `maxNominationsPerReplay`, a CASE record is bounded in bytes. The case BYTES are
not in the bundle: the verifier cannot be re-run offline; the intake consumer (`consumeCase`) is re-run at every replay
decision clock on the carried verifier output (`caseVerification: CONSUMER_RERUN_VERIFIER_OUTPUT_CARRIED`).

### The experiment replay engine (S01–S08)

`judge/experiment-replay.js` replays one sealed bundle into independent REPLAY arms. Each funded arm is its own hypothetical
account (USD 500 from the policy, its own memory journal / reducer / paper adapter with its own depletion / reservations /
positions / Watch / Judge) composed through the production `composeJudge` with a research-only `armRule` (enabled setups,
the RANGE_IGNITION FI15 / FI60_POSITIVE ablation, the seeded nomination thinning, the challenger whose verdict gates
admission) or an `exitPolicy` (`{ plannedTarget: false }` disables ONLY the planned full exit at the frozen target). Arms:
`REF_<setup>`, `REF_COMBINED`, `CASH`, `D1_PRESSURE_TO_PROGRESS`, `D2_FLOW_EVENT_RESPONSE` (needs WHALE), `D3_RESIDUAL_IGNITION`
(needs PEER), `MOMENTUM_ABLATION`, `SEEDED_NOMINATION_CONTROL`, `D4_TRAIL_CONTINUATION_FUNDED`, `D4_TRAIL_CONTINUATION_MATCHED`
(one isolated episode account per REF_COMBINED entry that reached its final R, the identical cloned entry, the alternative exit,
never summed into a funded return). The admission law under a challenger arm: D1 admits only KNOWN ALLOW; D2 admits KNOWN ALLOW
or KNOWN NO_RULE (a known absence of an anomaly) — missing evidence is UNKNOWN and refuses; D3 admits KNOWN ALLOW; every verdict
is a closed record (`verdictRecords`) that names the decision it gated, and the decision record carries the verdict words.
Tie order (`judge-replay-tie-order-1`, persisted in every report): timers due strictly before the next receipt fire first (the
25 ms admission bucket, then at 250 ms boundaries the heartbeat), same-time records apply in capture order, then same-time
timers, then scheduler drain and dispatcher queues, arms in declared order. Arm accounts are bound to experiment, code, policy,
rule version, tie order, source prefix and seed; a dirty tree has no code identity (`codeIdentity: UNKNOWN_DIRTY_TREE`). Fills
come only from subsequent eligible observations (the paper venue law). At the end an open position is CENSORED with a
factual conservative mark or an unknown mark (equity null), never FLAT. Restart law: a run stopped at a sequence and a fresh
replay of the same sealed prefix restore the same state (journal head, revision, depletion digest) in a fresh REPLAY
namespace; there is no partial-state resume.

Honest limitations: the challenger windows read the arm's own retained snapshots (180 s) — an anomaly response window older
than that is UNKNOWN (BOOK_ENDPOINTS_MISSING); D3 peer returns come from the arm's own accepted books for admitted peers or
from PEER records whose endpoints match the exact window, otherwise the peer stays missing (UNKNOWN, never ALLOW); the
forward composition now closes live one-minute bars on every tick (previously only on the 10 s maintenance pass, which left a
candidate without indicators for the confirming books).

### The prospective experiment and the holdout chain (H01–H05, D01, D02)

`judge/experiment.js` over `judge/experiment-store.js` (PostgreSQL migration 9 `serpent_experiment_records`, append-only,
digest-chained, serialized per experiment with a revision check; a memory twin for offline tests). `declare-experiment`
persists ONCE the exact UTC development / validation / holdout boundaries from a chosen future start + duration and the
declared fractions (holdout = remainder), the embargo, the horizons (lookback, decision, max outcome, publication floor),
the seed and the policy / code / strategy / arm-version / source bindings; a past start is refused unless `--exploratory
true`, which can never open a holdout. Groups (episode level from a replay report; catalyst / source levels through the same
API) are assigned by their first-known UTC instant; a group whose horizon spans a cutoff, starts inside the embargo after a
cutoff or ends inside the embargo before one is PURGED whole; an incomplete outcome or unreached publication floor is PENDING;
a late arrival keeps its UTC assignment and is flagged; groups outside the window are named. `evaluate-experiment` persists
development / validation looks over a `replay-experiment` report and refuses HOLDOUT; `lock-candidate` requires both looks
and locks once; `open-holdout` requires the lock and the completed window + outcome horizon, persists the opening record
BEFORE computing anything, serializes concurrent openings to one, resumes under the same run id after a crash, refuses
another run id, evaluates only the locked arm and persists the bound evaluation once. `verify --experiment` re-verifies the
record chain; `prepare-release --experiment` embeds the store's holdout chain (lock → first opening → bound evaluation) and
the release validator blocks `HOLDOUT_CHAIN_MISSING` / `HOLDOUT_CHAIN_INVALID` — legacy artifacts without a chain are
unqualified; `verify --manifest --experiment` refuses a manifest whose embedded chain differs from the store.

The legacy `evaluate` command and `evaluateArms` remain as HISTORICAL_ATTRIBUTION of one recorded ledger (`kind`,
`limitation` fields): a filtered ledger is not a strategy comparison; the replay engine is. The legacy index-based
`predeclareSplits` keeps its old behaviour for the legacy command and is reproduced as the defect it was (D02).
