# PHASE C-2 REPORT — State Machine + Spaceship Shell

**Date:** 2026-09-02 · **Branch:** `claude/cobra-phase-c1-setup-n9yy6r` · **Tests:** 21/21

## Branch decision

Stayed on `claude/cobra-phase-c1-setup-n9yy6r`. It is the repository's only (and
therefore default) branch; a merge to `main` would have created ceremony, not
safety. `git fetch` before push confirmed remote tip `4a84e32` matched local —
the Replit workspace's `.replit` commit has not been pushed yet, so there was
nothing to merge and nothing was overwritten. No force-push.

## Part 1 — Posture state machine (`state/posture.js`, rewired `state/machine.js`)

- Five postures with an explicit legality map drawn for the full hunt cycle
  (COILED → STALKING → STRIKE → DIGESTING → COILED; RETREAT reachable from
  everywhere; only COILED exits RETREAT), so C-3 inherits the map, not a rewrite.
- **Unreachable enforcement:** outside demo mode, any transition into
  STALKING / STRIKE / DIGESTING throws `NotYetImplemented`. Illegal edges
  (e.g. COILED → DIGESTING) throw `IllegalTransition` even in demo.
- **RETREAT causes wired to C1-6, not reimplemented:** KILL latch, daily
  HARD_LOCK, tape DEGRADED/OFFLINE. One addition beyond the brief's letter,
  in its spirit: a tape status file frozen at LIVE (dead tape process) counts
  as a data-integrity RETREAT cause — frozen is not LIVE.
- Every real transition appends `{ts, from, to, cause, demo:false}` to
  `data/state/transitions.jsonl` and persists posture to `data/state/posture.json`.
  The log already carries a true story from this session:
  `COILED → RETREAT "tape status frozen 9242s ago"` then
  `RETREAT → COILED "all retreat causes cleared"` when the tape came back.
- `index.js` now prints the true posture (`COBRA RETREAT — STANDING DOWN (…)`
  when applicable); on a fresh clone it prints `COBRA COILED — NO TRADE` and
  exits 0 exactly as the drill requires. A tape that has *never* run (no status
  file) is COILED — a cobra at rest, not in retreat; strikes are independently
  refused by cost/ledger anyway.

## Part 2 — Spaceship shell (`ui/server.js`, `ui/index.html`, `npm run ui`)

Zero dependencies held: Node's `http` for the server, vanilla HTML/CSS/JS for
the cockpit, one self-contained page. Serves on `0.0.0.0:$PORT` (default 3000)
so Replit's webview picks it up.

- **Server is read-only by construction** — it has no write route of any kind.
  `/api/status` syncs posture exactly like `cobra status`; `/api/coin/<COIN>`
  reads the tape's current-book file and refuses (`available:false`,
  UNAVAILABLE + reason) when the tape is not effectively LIVE or the book is
  stale. No number is ever computed from anything but disk.
- **Cockpit:** parallax starfield (3 layers, slow drift) with Ophiuchus hidden
  in the brightest stars; central glowing verdict in plain words
  (COILED → "WATCHING — NO TRADE", RETREAT → "STANDING DOWN" + cause);
  serpent glyph coiled around the verdict ring, drawing itself on boot,
  leaning toward the target when stalking (demo); five labeled planets
  orbiting with depth (scale/opacity by z); posture-as-temperature palette
  (cool teal → amber → hot flash → warm → drained grey with desaturation);
  lock ring with +5/+8/+11 ticks filling with daily paper P&L (hidden with no
  session data); thin outer ET-session arc + ET clock chip; tape chip with
  LIVE/DEGRADED/OFFLINE/FROZEN/ABSENT + staleness seconds, and "SHELL LINK
  LOST" if the page loses its server; tap-a-planet detail card (mid, bid/ask,
  spread bps, book age, levels, depth bars at ±5/10/25bps both sides);
  1.9s boot sequence, tap to skip; `≋ MOTION` toggle + `prefers-reduced-motion`
  respected (stars still, breathing/pulsing off).

## Part 3 — Demo mode

- Entered only by `?demo=1` or triple-tapping the verdict; never by default.
  Unmistakable gold DEMO ribbon; tapping it (or triple-tap) exits and re-renders
  true state instantly from the last real payload.
- Cycles COILED → STALKING(SOL, reticle + pull-in) → STRIKE(flash) → DIGESTING
  → RETREAT with "DEMO — STAGED" captioning. Detail cards in demo show dashes
  and "THESE ARE NOT MARKET VALUES" — no fabricated numbers styled as real.
- **Isolation is structural and tested:** demo visuals are client-side only and
  the server has no write endpoints; at the machine level, a demo
  `PostureMachine` walks all five postures while a byte-for-byte snapshot of
  the data directory proves nothing was created, touched, or grown, the
  persisted posture is unchanged, and the transitions log contains no demo rows.

## Verification

- `npm ci && npm start && npm test` — green. (`npm ci` needs a lockfile, which
  a zero-dependency repo had never generated; `package-lock.json` is now
  committed. Zero runtime dependencies remain.)
- 21/21 tests: all 15 C-1 drills plus 6 C-2 drills (hunt-cycle legality,
  illegal edges, NotYetImplemented enforcement, RETREAT causes each logged,
  transition-log shape, demo isolation).
- Live verification at 390×844 (screenshots in `doctrine/c2/`):
  - `c2-coiled-live.png` — true COILED from a LIVE tape; verdict, serpent,
    lock ticks, session arc, tape chip `TAPE LIVE · 0.8s`.
  - `c2-card-sol.png` — real SOL card from the live book: mid 99.885,
    spread 1.00 bps, book age 4.9s, 100/100 levels, depth bars.
  - `c2-demo-stalking.png` — demo STALKING: SOL pulled to the center with
    amber serpent-eye reticle, DEMO ribbon, "TARGET · SOL / DEMO — STAGED".
  - `c2-retreat-killed.png` — `cobra kill` latched → "STANDING DOWN / KILLED",
    scene drained grey; latch cleared afterward with `cobra state clear`.
  - UNAVAILABLE path verified over HTTP: with the tape stopped/stale the coin
    endpoint returned `UNAVAILABLE — NO TRADE (tape OFFLINE)` / `book stale`,
    and the card renders that refusal verbatim.

## Deviations from the brief

1. **Frozen-tape RETREAT cause** (above) — added; a dead tape process must not
   read as LIVE.
2. **`index.js` posture line** — no longer prints COILED unconditionally; it
   prints the true posture. Fresh-clone drill output is unchanged.
3. **`package-lock.json` committed** — required for `npm ci`; no dependencies.
4. Book depth bands on the card use the tape's stored 100-level books; a $5k+
   walk display is the cost model's job (`cobra cost`), not the card's — the
   card stays a glance, not a terminal.

## Not started (by instruction)

C-3 (meme radar / Tier C rules) and C-4 (SIGINT mesh). The 24h clean-tape
criterion for C-1 still awaits the Replit run; C-2 did not depend on it.
