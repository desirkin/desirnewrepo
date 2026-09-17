# The second lane — RUMOR-2 on a worker thread (PUBLISH-FIX-36, 2026-09-17)

**Why.** The paper deployment ran every job on one Node thread: tape + Judge + execution (the frozen core) and the whole
research side. At 70–80% utilization one market-wide burst (2026-09-17 12:00 UTC) jammed that lane; the tape's resource
law benched 9 of 19 coins to keep the Judge fed. The machine has four cores; the app used one.

**What moves.** The RUMOR-2 ear — Bluesky firehose, the official ears (Kraken / SEC / CFTC / EDGAR / OFAC), the research
strainer and its 130k-event journal hydrate — runs on a worker thread (`lanes/research-lane-worker.js`). It was the
largest non-frozen CPU and memory consumer. Tape, Judge, execution, Watch, the persistence spine, the cockpit, the wide
eye, market research and learning stay on the main thread.

**The switch.** `SERPENT_RESEARCH_LANE=worker` (with `RUMOR2_ENABLED=true`) composes the lane; unset, fly.js composes the
ear in-process exactly as before. Flipping the switch is a republish; nothing else changes. If the lane misbehaves, unset
it and republish — the OFF position is the code path that ran all of 2026-09-17.

**What crosses the boundary (serialized, read-only, the same seams as before).**
- main → lane: the wide eye's detached catalog snapshot / research notices / completed-sweep population (SOCIAL-4F), the
  research owner's retained deep-market windows for the declared subjects (MARKET-LAB), the subject coin list, `stop`.
- lane → main: the ear's status + the RAM-only current-social snapshot (the cockpit's `/api/social/current`), the detached
  research projection per subject coin (the research service's social projection and the case trigger's dossier flags),
  `ready` / `stopped` / `fault`.
- Files the ear read before it reads still: tape feature snapshots, tape status, the current universe, the Childhood
  archive. The memory mirror tails `rumor2/events.jsonl` exactly as before.

**Durable core.** The lane attaches to PostgreSQL on its own small pool (`persistence/attach.js`): it verifies the schema
version the spine migrated and never migrates, restores or takes the runtime lock. The RUMOR-2 writer lock is a session
lock, so it belongs to the lane's connection and ends with it.

**Freshness law.** Every answer the main thread gives from the lane is the lane's latest delivered snapshot (status every
15 s, projections every 30 s), stamped with the lane clock that produced it; a coin the lane never projected answers
NOT_CONNECTED, never an invented projection. A lane that exits stays DOWN for the session (dark; the log names the exit;
the Judge never depended on it).

**Log lines.** `RESEARCH LANE: RUMOR-2 composed on the second lane`, `RESEARCH LANE up: …`, `RESEARCH LANE: attached to
the durable core …`, `RESEARCH LANE exited (code N)`, `RESEARCH LANE stopped (STOPPED)`.

Authority NONE in both lanes. No return path to the Judge exists here.
