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
   sample, untouched holdout, fees accounted, no open positions), passing critical suites, an independent review PASSED,
   proposed limits; otherwise BLOCKED with named blockers.
3. `approve-release` (owner intent; bounded written assessment that states uncertainty) → durable approval; it grants
   eligibility for the remaining checks only.
4. `preflight-live --allow-private true` (owner intent): read-only private checks — server time, key permissions
   (redacted: fingerprint + allowlisted permission facts; the echoed key is never persisted), balance, open orders. Sends
   no order. Creates the LIVE journal account on first success.
5. `arm-live --challenge true` then `arm-live --confirm true --expires-at .. --owner-limits FILE --preflight FILE`:
   the authorization binds account / mode, venue, release / policy / code digests, allocation ceiling ≤ verified funds,
   reinvestment policy, every cap, key fingerprint, issuance / expiry (≤ `live.armExpiryMs`) and the restriction
   revision. `OWNER_LIMITS_REQUIRED` until the owner chooses limits.
6. `run-live --allow-private true` (owner intent): claims the venue owner slot, reconciles, preflights again in-process,
   resumes the SAME unexpired authorization (mode → LIVE_ARMED), connects the private executions channel, runs the tape.
   A changed code / policy / key binding on restart ENDS the old authorization; exposure stays managed under its recorded
   safety policy. Expiry stops additions; owned exits / protection continue.
7. `canary-live` needs its OWN short-lived CANARY authorization (`arm-live --canary-pair .. --canary-max-consideration ..
   --canary-max-duration-ms .. --canary-loss-acknowledged true`): one bounded entry on one pair; ordinary and canary
   authorizations are mutually exclusive on an account. It costs fees and can lose money.

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

Named, uncovered cases (not silently green): (1) a late adapter callback arriving AFTER `stop()` released the writer is
refused by the epoch fence (D03/D07) but no test drives a socket callback through the closed dispatcher; (2) the
executions-channel reconnect / resubscribe after a sequence gap emits `RECONCILIATION_REQUIRED` (E04) but the
re-subscription itself is not exercised end-to-end; (3) file-system fsync / short-write faults on the projection and
recorder files are handled as logged failures, not injected in tests; (4) the canary run is implemented and unit-bound
but was never executed against a venue.

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
