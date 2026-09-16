# docs/serpent — read these first

The working doctrine and state of the Serpent build, kept IN the repo so any session with the code has the whole picture.
The Cobra Strike project on claude.ai holds the same documents; when they disagree, the newer commit wins and the other is updated.

1. `PHILOSOPHY.md` — what David is building, in his words. Every ticket is judged against this.
2. `APP-MAP.md` — plain-English map of the code: the two programs, the decision path, the senses, persistence, learning, risks.
3. `WHAT-IT-IS.md` — short assessment.
4. `LEAN-PLAN.md` — the trim: duplicates and scaffolding out; no sense, decision or learning module leaves.
5. `BASELINE.md` — branch, suite status, commits, test recipe.
6. `RUNTIME-UNIFICATION.md` — one program, one mode switch: the six ordered steps (1–2 landed).

Working law: one ticket at a time; full suite green before and after; fences updated deliberately, never silently; every audited change to judge/, execution/ or watch/ gets a `docs/JUDGE-PAPER-AUDIT.md` entry and a digest re-pin. David clicks Publish and turns paid senses on; everything else is the session's.

## Standing orders for the working session (2026-09-14)
The session that holds this repo IS the worker. David is not a coder and does not copy/paste: he clicks Publish in Replit and turns paid senses on; everything else is the session's. Secrets live in Replit by NAME only; never ask for a value.

Cadence: work continuously, one ticket at a time, push `serpent/baseline` after every green ticket (`git push origin serpent/baseline`). Use the lightest sub-agent model that can do each piece; hold every ticket to what you would grade 10/10 for usability, maintainability and functionality (edge is the one thing nobody can promise). Lean: keep everything David wants (every sense — RUMINT, X, Meta, social ears, infra — every decision and learning module stays); trim only duplicates and scaffolding, and retire code to `attic/` with `git mv`, never delete. Human readability of code is not the goal — a single AI holding the whole thing is.

First action on taking over: run the full suite (recipe in BASELINE.md; PostgreSQL 16 required) and fix anything red BEFORE the next ticket. Step 2 of the runtime unification (`679f358`) landed with its targeted fences green and the full run in flight in the previous session — confirm it here.

## Standing order update (2026-09-16) — queue, backlog, open questions
The session never idles while unblocked work exists. Three lists, in this precedence:
1. **The queue** — the tickets David has handed the session (this file + the current session). Work them top to bottom, one green push each.
2. **`BACKLOG.md`** — an ordered list of no-decision work, each with acceptance criteria the session writes itself. When the queue is empty, pull the top backlog item. Extend the backlog whenever no-decision work is noticed. Never hold with an unblocked backlog item remaining.
3. **`OPEN-QUESTIONS.md`** — when a ticket needs a human answer, write the question there (ticket id + recommendation) and move on to the next item. Never park-and-wait on a question: keep moving.

CI: the `serpent/baseline` workflow keeps `concurrency: cancel-in-progress: true` — a newer push supersedes an in-flight run; the branch tip is the run that must be green.

Queue, in order (details in RUNTIME-UNIFICATION.md, PHILOSOPHY.md, LEAN-PLAN.md):
1. Runtime unification steps 3–6: fly.js onto the spine with `SERPENT_MODE`, in-process cockpit, mode-agnostic lock/status paths, retire the shims. Audit §4.7 entry; composition.js untouched.
2. PERSIST-1: object-store adapter + restore-on-boot (Replit's filesystem resets on publish).
3. Learning seam: record a prediction on EVERY PAPER decision from minute one; yardstick = the bite window (4–6 min) and the minutes after, not the 60-min log return; ENTRY/EXIT/SIZING stay UNSUPPORTED until qualified — dormant, never dark.
4. Watch exit law: the exit is the entry thesis being invalidated; the fixed timers become backstops; no target price or percent anywhere.
5. PAPER publish (David clicks): one root, DATA_ONLY first, then PAPER.
6. Senses → case → Socrates → Judge wire (the differentiator); "Talk to them" = real LLM explainer grounded in the decision record, read-only, after the fact; Judge stays a non-LLM rule engine.
7. DATA-1 / SIM-1: the ≥10%-mover daily study, down days included.
8. Three accounts — David, Cerulean, Cody (closed set): one app, one page, dropdown; identical paper balances now, real Kraken keys per account later.
