# 🐍 SERPENT / COBRA ENGINE

Automated long/flat crypto **research & paper-trading** engine. PAPER-FANGED — no live
capital, no exceptions until data earns it. The going-forward doctrine lives in
[`docs/serpent/`](docs/serpent/) (start with `PHILOSOPHY.md` and `READINESS.md`);
[`DOCTRINE.md`](DOCTRINE.md) is the standing authority and outranks everything else.

## Layout

| Dir | Purpose |
|---|---|
| `/tape` | Market-data ingestion — Kraken WS v2 ticker/trades/L2 book, checksum-verified, JSONL persistence |
| `/cost` | Execution-cost model — Gate Zero; walks the live book, refuses when the tape is degraded |
| `/judge` | The non-LLM decision engine (frozen for paper): risk, sizing, adapters, experiments |
| `/execution` | Paper adapter, reducer, ledger view — price-blind ordering enforced in code |
| `/watch` | Position watch / exit law (thesis invalidation; timers are backstops) |
| `/state` | Posture machine, daily session locks, KILL / CAGE / VETO controls |
| `/market-lab` | Research providers + the Socrates case/research service (authority NONE) |
| `/rumor2` | Social / official-feed ears (RUMOR-2) |
| `/persistence` | PostgreSQL journal authority + the durable object store (App Storage) |
| `/paper` | Paper profile, preflight, sensor inventory, launch |
| `/ui` | Read-only cockpit (controls fail closed without auth) |
| `/lib`, `/gateway`, `/survey`, `/learning`, … | Shared config, collectors, the Wide Eye, the learners |

Runtime data (tape, journals, state latches, research) lives under `data/<generation>/`
— gitignored, append-only JSONL plus the PostgreSQL journal. See
[`docs/serpent/READINESS.md`](docs/serpent/READINESS.md) for the data generation and
durable-storage setup.

## Requirements & drill (after every pull)

- **Node 22** (`engines.node >= 22`; the deployment runs Node 22).
- **PostgreSQL 16** for the durable journal — `pg` is the one runtime dependency.

```bash
npm ci        # installs pg (the one dependency)
npm start     # must print: COBRA COILED — NO TRADE  (exit 0)
npm test      # the full offline drill (real PostgreSQL; DB-backed tests need PERSIST_TEST_DATABASE_URL)
```

## Running the tape

```bash
npm run tape                                   # continuous
node bin/cobra.js tape run --minutes 10        # timed drill
node bin/cobra.js tape run --minutes 10 --chaos-after 120   # kills the socket once to prove DEGRADED + resync
```

Snapshots/trades/events land in `data/<gen>/tape/<ET-date>/`; current books under
`data/<gen>/tape/books/`; feed health in `tape/status.json`. A stale feed (> 10 s) ⇒
tape `DEGRADED` ⇒ engine forced `NO TRADE — DATA INTEGRITY`.

## Cost model (needs a running tape)

```bash
node bin/cobra.js cost SOL 1000            # one size
node bin/cobra.js cost SOL 1000 --ladder   # a size ladder
```

Prints TRUE_ENTRY_COST, TRUE_EXIT_VALUE, round-trip friction and the break-even move;
refuses with `UNAVAILABLE` when the tape is degraded, stale, or absent.

## Controls & locks

```bash
node bin/cobra.js status               # posture, tape, locks, open positions
node bin/cobra.js kill                 # flat everything, halt → RETREAT
node bin/cobra.js cage                 # no new strikes, manage exits
node bin/cobra.js veto <id>            # deny one trade
node bin/cobra.js state simulate 8.5   # inject a simulated daily P&L (drill)
node bin/cobra.js state clear          # human clears KILL/CAGE latches
```

## Paper day

```bash
npm run paper:preflight                # read-only gate report; verdict READY_FOR_PAPER when clear
npm run paper:inventory                # the derived sensor inventory
node bin/cobra.js paper snapshot       # the readiness snapshot
npm run paper                          # launch the paper day (applies the profile; forced authority names always win)
```

The paper-day checklist — every secret NAME, the gates, and the click order — is
[`docs/serpent/READINESS.md`](docs/serpent/READINESS.md).

## Collector readers (data-only surfaces)

```bash
npm run data:only                      # the data-only collector runtime
npm run data:only-ui                   # data-only runtime + the in-process cockpit (the deployment entrypoint)
npm run data:status                    # runtime status
node bin/cobra.js learning status      # the learner's status
node bin/cobra.js discovery status     # public-discovery collector status (also: press)
```

Daily locks (ET session anchor): **+5% SELECTIVE / +8% PROTECT / +11% HARD LOCK** — the
daily target may stop trading; it may never cause trading.
