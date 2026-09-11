# SERPENT PAPER RUNBOOK

The ONE way to run the paper profile. Real money is DISABLED; live orders are DISABLED; withdrawals and funding are
DISABLED. The Judge runs `PAPER` against the PostgreSQL journal with a simulated venue; Watch manages paper positions;
every mature lawful sense runs under `config/paper-runtime.json`; the dark research capture runs with ZERO authority.

## 1. Commands

| Step | Command | What it does |
|---|---|---|
| Preflight (read-only, zero paid calls) | `npm run paper:preflight` (= `node bin/cobra.js paper preflight`) | Sections A–L below; exit code 1 when `NOT_READY_FOR_PAPER`. `--json` prints the report; `--smoke` adds ONE read-only Kraken Charts poll and the L3 key proof (still zero paid calls; X and any paid provider stay untouched). |
| Owner intent (once per database) | `node bin/judge.js init-paper --policy config/judge.paper.json` with `JUDGE_OWNER_PASSWORD` | Creates the PAPER account (USD 500 reference) with owner intent verified against `SERPENT_CONTROL_PASSWORD`. |
| Launch | `npm run paper` (= `node bin/cobra.js paper run`) | Applies the profile to the environment (forced authority names always win), starts the dark capture runner a few seconds later, then hands the process to the proven `fly.js` composition. |
| Inventory | `npm run paper:inventory` | Regenerates the machine-readable sensor inventory (`docs/sensor-inventory.paper.json`). |
| Snapshot | `node bin/cobra.js paper snapshot` | The shared sensor snapshot (same rows the cockpit SENSES drawer shows). |

Stop with `SIGINT` / `SIGTERM`: the Tape closes, the Judge and the research service stop, the paper shutdown seam seals a
dark segment in flight, then the process exits 0.

Replit's Run button and deployment command use `npm run paper`. Configure the required environment and initialize the
paper account before starting. A failed or malformed account / writer-lock check is a core blocker: an unknown result
cannot establish readiness. Preflight checks database state without modifying it; a running writer must be stopped
cleanly before using the preflight as a launch gate for its replacement.

The market-driven setups (`MARKET_DIRECT`) can qualify without a Socrates model response. Catalyst transmission requires
an admissible case. A conversational operator interface is separate from those decision paths. The shipped model remains
disabled, and that limitation must remain visible.

After startup, inspect the JUDGE and SENSES drawers. A candidate needs 61 accepted closed one-minute bars and 21 minutes of
continuous trade coverage, plus the setup's other inputs. Warmup is per candidate and is affected by gaps and replacement;
21 minutes is not a promise that a trade will occur. Verify fresh market data, a PAPER Judge and adapter, durable journal
updates, candidate readiness or explicit refusal reasons, and Watch status. Do not weaken the strategy to force a fill.
Record the deployment commit, policy digest and UTC paper-run start. Preserve the account and journal across restarts.

## 2. Environment

Copy `.env.paper.example` (NAMES and placeholders only) into your process manager's private environment. Required for
`READY_FOR_PAPER`: `COBRA_PROFILE`, `COBRA_DATA_DIR` (a persistent mount in deployment), `DATABASE_URL`,
`SERPENT_CONTROL_PASSWORD`, `SERPENT_HTTP_CONTACT`. Everything else is optional and only widens the sense set; no value turns
a paid or private activity on by itself.

Forced by the launcher regardless of the environment: `JUDGE_MODE=PAPER`, `JUDGE_ALLOW_PRIVATE=false`,
`JUDGE_ALLOW_ORDERS=false`, `RUMOR2_SOCIAL_MODE=LIVE`. Never present: a Kraken trading key. A Kraken L3 key, if any, is a
dedicated DATA-ONLY key (`create-ws-token` only) and is proven before use (`SAFE_L3_DATA_KEY`), never an execution credential.

## 3. Composition order (fly.js, unchanged)

persistence bootstrap (restrictive first) → cockpit status server → memory mirror → RUMINT legacy ear → gateway (exchange
infrastructure) → wide eye / universe → governance (dark; off) → market research owner + Socrates case runtime → Judge
PAPER (+ Watch, paper execution) → RUMOR2 official + social ears + strainer → Tape feed loop (blocks until a signal) →
stops → paper shutdown seam → exit.

## 4. Preflight sections and blocker groups

Sections: `A_CODE` (commit, dirty files, policy digests, forced environment), `B_STORAGE` (data dir, PostgreSQL schema,
account, advisory lock — read-only), `C_CORE_MARKET`, `D_RUMOR_OFFICIAL`, `E_SOCIAL`, `F_MARKET_RESEARCH` (public probes),
`G_DARK_EDGE_CAPTURE`, `H_SOCRATES`, `I_JUDGE`, `J_WATCH`, `K_CONTROLS`, `L_FINAL`.

Blocker groups: `CORE_CODE_BLOCKER` and `CORE_RUNTIME_BLOCKER` decide `READY_FOR_PAPER`; `EXTERNAL_OPTIONAL_SENSE_BLOCKER`,
`PAID_SENSE_NOT_AUTHORIZED` and `DARK_RESEARCH_BLOCKER` are reported truthfully and never block the paper run.

Runtime state vocabulary (closed; zero `UNKNOWN` rows): `ACTIVE`, `ACTIVE_DEGRADED`, `BLOCKED_CREDENTIAL`,
`BLOCKED_BUDGET`, `BLOCKED_EXTERNAL_APPROVAL`, `BLOCKED_TERMS`, `BLOCKED_RETENTION`, `BLOCKED_GEOGRAPHY`,
`BLOCKED_PROVIDER`, `FOUNDATION_ONLY`, `DISABLED_BY_PAPER_POLICY`; plus `NOT_OBSERVED` (nothing recorded yet),
`CONFIG_REQUIRED:<name>`, `KEY_PRESENT_UNPROVEN`, `BLOCKED_NO_SAFE_L3_DATA_KEY`, and the dark states
`DARK_CAPTURE_OPERATIONAL` / `DARK_CAPTURE_BLOCKED_EXTERNAL` / `DARK_CAPTURE_DEGRADED` / `DARK_CAPTURE_DISABLED_BY_POLICY`.

## 5. The sensor snapshot (`paper/readiness.js`)

`sensorSnapshot()` returns `{ snapshotVersion, generatedTs, profile, runtimeMode, authority, groups, rows, counts,
controls, locks, persistence, law }`. Every row carries exactly `id, name, group, state, desiredState, lastSuccessTs,
ageMs, coverage, blocker, detail, authority`. Groups: `MARKET`, `OFFICIAL`, `SOCIAL`, `INFRASTRUCTURE`, `DARK_RESEARCH`,
`SOCRATES`, `JUDGE`, `WATCH`. A sense is `ACTIVE` only from a FRESH status record; a stale record is `ACTIVE_DEGRADED`;
nothing recorded is `NOT_OBSERVED`. No secret value can enter the snapshot (the builder throws on a value-like string).
The cockpit reads it at `/api/sensors` (read-only) and shows it in the SENSES drawer.

The two dark families capture under a SIBLING root, `<research root>-dark` (default `data/market-research-dark`): the
research owner holds its own root's provider quota lock, and nothing under the dark root is ever read by Socrates, the
Judge, Watch or execution. Its status file is `<dark root>/edge-capture-status.json`.

## 6. Authority (printed by preflight and launch)

```
REAL MONEY: DISABLED
LIVE ORDERS: DISABLED
WITHDRAW/FUNDING: DISABLED
PAPER MODE: <READY_FOR_PAPER | NOT_READY_FOR_PAPER>
DARK KRAKEN JUDGE AUTHORITY: NONE
DARK KRAKEN SOCRATES AUTHORITY: NONE
THRESHOLD CHANGES: NONE
```

## 7. Frozen components

`judge/*`, `execution/*` and `watch/watch.js` are `FROZEN_FOR_PAPER` (digests in `docs/JUDGE-PAPER-AUDIT.md` §4, fenced by
`test/paper-runtime.test.js` P-08). Socrates runs as a case runtime only (authority `SEALED_CASE_INPUT_ONLY`: the Judge reads
byte-verified sealed cases and nothing else from it); its model is `DISABLED_BY_PAPER_POLICY` until an operator sets
explicit USD caps in the paper research policy.

## 8. Ask Serpent (the operator conversation)

The cockpit's ASK button opens the read-only conversation over the recorded evidence. It answers the six operator
questions (what are you doing, why did you buy / skip a coin, what The Watch is watching, how the paper account is doing
after costs, which senses work or are blocked) from the same views the drawers show: the Judge projection bound to the
running account and mode, the sensor snapshot, the research summary, and ONE bounded page of the execution journal when a
decision is older than the projection's latest-12 window. Every answer carries its evidence timestamp and identifier and
one of RECORDED / UNVERIFIED (stale projection) / UNAVAILABLE (rejected projection, Judge off). It never invents a reason
the Judge did not record, keeps recorded rationale apart from interpretation, and uses the Judge paper account's canonical
realized / unrealized fields, never the legacy ledger. Questions are untrusted text: they select an intent and a coin and
nothing else. The panel has no authority: it cannot place, cancel, arm, clear, initialize or reset anything.

Free-form AI chat (`POST /api/ask` with mode `chat`) is optional and paid: it needs an authenticated operator session
(session + CSRF, like a control) AND `ANTHROPIC_API_KEY` AND explicit `SERPENT_CHAT_MAX_USD_PER_REQUEST` and
`SERPENT_CHAT_MAX_USD_PER_DAY`. Until then the panel says plainly that AI chat is not configured and keeps answering from
the recorded evidence. No call happens on open or refresh; every send is one explicit request, refused before dispatch
when the estimate breaks a cap; the daily ledger (`<data dir>/companion/companion-spend.json`) survives restarts. The
model receives the evidence answer as data and has no tools. Voice input is not implemented; the typed panel is the
interface.

## 9. Operator actions that remain outside the code

- Provision PostgreSQL and set `DATABASE_URL`; run `init-paper` once with owner intent.
- Set `SERPENT_HTTP_CONTACT` (SEC / EDGAR user-agent law) and, when wanted, an explicit `RUMOR2_EDGAR_CIKS` whitelist.
- Optional free keys (FRED) widen the market set; paid providers and X stay off until plan, budget and an explicit paid
  smoke are attested in the policy / environment.
- A Kraken L3 DATA-ONLY key (never a trading key) unlocks the dark L3 capture after its permission proof.
- Rotate any provider key value that was ever placed in a committed file (see the final report §15) and move it to the
  platform's secret store; this repository carries names and placeholders only.
