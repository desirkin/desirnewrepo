# DEPLOYMENT & PERSISTENCE NOTES

## How COBRA persists state

| State | File(s) | Write pattern |
|---|---|---|
| Paper ledger (predictions/fills/exits) | `data/ledger/*.jsonl` | Append-only JSONL, **fsync'd per row** (price-blind ordering depends on durability) |
| Control latches (KILL/CAGE/VETO) | `data/state/controls.json` | **Atomic** temp+rename |
| Control action log | `data/state/controls_log.jsonl` | Append-only JSONL, fsync'd per row |
| Posture | `data/state/posture.json` | **Atomic** temp+rename |
| Posture transitions | `data/state/transitions.jsonl` | Append-only JSONL |
| Tape current books / feed status | `data/tape/books/*.json`, `data/tape/status.json` | **Atomic** temp+rename |
| Tape history (trades/snapshots/events) | `data/tape/<ET-date>/*.jsonl` | Append-only JSONL |
| Daily rollups | `data/ledger/rollups/*.json` | **Atomic** temp+rename |

Two patterns, deliberately:

- **Atomic temp+rename** for every "current state" file — a crash mid-write can
  never leave a torn file; readers see the old state or the new state, nothing
  in between. All of these go through `atomicWriteJson()` in `lib/jsonl.js`.
- **Append-only JSONL** for every log — rename would clobber history, so logs
  append instead; a torn final line from a crashed writer is skipped by
  `readJsonl()` (never repaired, never invented). Ledger rows and control
  actions are additionally fsync'd so an acknowledged write is on disk.

## Where the data lives

Everything is under `data/` at the repo root (gitignored), resolved relative
to the repo — no absolute or workspace-only paths. The `COBRA_DATA_DIR`
environment variable relocates the whole tree without code changes.

## Replit: workspace vs deployment

- **Replit workspace** (the editor + Run button): the filesystem **persists**
  across restarts and pulls. `data/` survives. This is where Phase C runs.
- **Replit Deployments**: **Autoscale and Static deployments have an
  ephemeral filesystem** — every deploy/restart starts from the build, and
  anything written to `data/` is lost. Running COBRA there would silently
  amputate the ledger and the control latches. **Mitigation, in order of
  preference:**
  1. Don't deploy yet — Phase C is paper-fanged research; the workspace (or
     any plain VM) is the right home.
  2. If deploying, use a **Reserved VM** deployment (persistent disk) and set
     `COBRA_DATA_DIR` to a path on the persistent volume.
  3. Never run a deployment flavor whose disk resets. A fresh-wiped `data/`
     would erase KILL/CAGE latches — human controls must not be amnesiac.

## The paper profile

The ONE deployment target is the paper profile: `npm run paper:preflight` then `npm run paper` (see
`docs/PAPER-RUNBOOK.md`). The launcher applies `config/paper-runtime.json` to the environment and forces
`JUDGE_MODE=PAPER`, `JUDGE_ALLOW_PRIVATE=false`, `JUDGE_ALLOW_ORDERS=false` whatever the environment says; real money,
live orders, withdrawals and funding are disabled. The paper shutdown seam runs after the Tape's clean stop and before
`process.exit(0)` so a dark research segment in flight is sealed.

## Graceful shutdown contract

`SIGTERM`/`SIGINT` → the tape closes its websocket, writes a final
`TAPE_STOPPED` event and `OFFLINE` status, the UI server stops accepting
connections, and the process exits. All state writes are synchronous, so
nothing needs flushing beyond what is already on disk.
