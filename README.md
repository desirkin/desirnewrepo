# 🐍 COBRA ENGINE

Automated long/flat crypto **research & paper-trading** engine. PAPER-FANGED — no live
capital, no exceptions until data earns it. Read [`DOCTRINE.md`](DOCTRINE.md) first;
it outranks everything else in this repo.

## Layout

| Dir | Purpose |
|---|---|
| `/tape` | Market data ingestion — Kraken WS v2 ticker/trades/L2 book, checksum-verified, JSONL persistence |
| `/cost` | Execution cost model — Gate Zero; walks the live book, refuses when the tape is degraded |
| `/ledger` | Paper trade ledger — price-blind ordering enforced in code |
| `/state` | Posture machine (stub), daily session locks, KILL / CAGE / VETO controls |
| `/ui` | Spaceship shell — stub, Phase C-2 |
| `/doctrine` | Decision records (venue choice, etc.) |
| `/lib` | Shared: config, JSONL store, ET session time, CRC32 |

Runtime data (tape, ledger, state latches) lives under `data/` — gitignored, append-only JSONL.

## Build drill (mandatory after every pull)

```bash
npm ci        # no dependencies today, but the drill is the drill
npm start     # must print: COBRA COILED — NO TRADE  (exit 0)
npm test      # unit drills: checksum, book walk, price-blind gate, locks
```

## Running the tape

```bash
npm run tape                                   # continuous
node bin/cobra.js tape run --minutes 10        # timed drill
node bin/cobra.js tape run --minutes 10 --chaos-after 120   # kills the socket once to prove DEGRADED + resync
```

Snapshots/trades/events land in `data/tape/<ET-date>/`; current books in
`data/tape/books/`; feed health in `data/tape/status.json`. Stale feed > 10 s ⇒
tape `DEGRADED` ⇒ engine forced `NO TRADE — DATA INTEGRITY`.

## Cost model (needs a running tape)

```bash
node bin/cobra.js cost SOL 1000            # one size
node bin/cobra.js cost SOL 1000 --ladder   # $100 / $500 / $1k / $2.5k / $5k
```

Prints TRUE_ENTRY_COST, TRUE_EXIT_VALUE, round-trip friction, break-even move; the
maker-path variant is flagged `OPTIMISTIC`. Refuses with `UNAVAILABLE` when the tape
is degraded, stale, or absent. Every evaluation is logged to
`data/cost/evaluations.jsonl` with book ref + fee schedule version.

## Paper ledger (manual entries only in C-1)

```bash
node bin/cobra.js ledger predict SOL 500 --thesis "test plumbing" --horizon 30 --move 1.5
node bin/cobra.js ledger enter <prediction_id>     # simulated taker fill — only after the prediction is on disk
node bin/cobra.js ledger exit <prediction_id> TARGET
node bin/cobra.js rollup                           # daily rollup, ET session
```

## Controls & locks

```bash
node bin/cobra.js status              # posture, tape, locks, open positions
node bin/cobra.js kill                # flat everything, halt → RETREAT
node bin/cobra.js cage                # no new strikes, manage exits
node bin/cobra.js veto <id>           # deny one trade
node bin/cobra.js state simulate 8.5  # inject simulated daily P&L (drill)
node bin/cobra.js state clear         # human clears KILL/CAGE latches
```

Daily locks (ET session anchor): **+5% SELECTIVE / +8% PROTECT / +11% HARD LOCK** —
the daily target may stop trading; it may never cause trading.
