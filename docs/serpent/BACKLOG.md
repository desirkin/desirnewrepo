# Serpent backlog — no-decision tickets

Ordered list of work that needs NO human decision. Each item carries its own
acceptance criteria. When the main queue is empty, pull the top item here; never
hold idle while an unblocked item remains. Extend this list whenever no-decision
work is noticed. A ticket that turns out to need a human answer is written to
`OPEN-QUESTIONS.md` and skipped — never parked-and-waited-on here.

Standing order and how the queue/backlog/open-questions relate: `docs/serpent/README.md`.

---

## B-1. DROPPED — 2026-09-16 (owner decision): Prettier fights the intentional dense house style; no formatter lands.

## B-2. DONE — 2026-09-16 (8e488ed): the research-horizon maturation pass fills the 1h/4h/24h columns.
`learning/research-maturation.js` re-scores only those columns with the pure yardstick against a later,
fuller tape and appends to `learning/research-outcome-store.js` (head-selected supersede store), mirroring
`learning/maturation.js`. Older-than-horizon → KNOWN from the tape; younger → explicitly pending (never a
zero); series-absent → one OUTCOME_UNAVAILABLE attachment then skipped (no wedge). fly.js runs it after each
recorder tick, PAPER-gated, authority NONE. `test/research-maturation.test.js` RM-1..6.

## B-3. DONE — 2026-09-16 (2087ddb): post-cull BASELINE refresh. (READINESS refresh folds into the paper-profile / READINESS tickets.)
~~BASELINE.md + READINESS.md refresh after the cull~~
**Do:** update `docs/serpent/BASELINE.md` and `docs/serpent/READINESS.md` to reflect the
post-cull tree (retired social ears, the TwelveData / CROSS_ASSET market-lab cut, the
SENSE-CULL-2 FRED / Coin Metrics retirement, family count 16, provider count 16, sensor
scope 39, app line count).
**Acceptance:** no retired provider/family/sense named as live; the family/provider
counts and app-line figure match the code; full suite green (docs are not test-read, so
this is a truthfulness pass, not a fence change).

## B-4. DONE — 2026-09-16: TOTP brute-force codeAt eliminated (`control-auth-second-factor.test.js`, `totp.test.js`).
Both files recovered the current TOTP code by scanning all 10^6 six-digit candidates through `verifyTotp`
(~500k HMAC-SHA1 per call, called ~10× across the two files — the SF file's whole cost). Replaced with a direct
RFC-4226 dynamic truncation off the exported `base32Decode`, self-checked once against the production verifier so the
two can't diverge. Every SF-*/TOTP-* assertion is byte-for-byte unchanged (identical codes). The SF file runs in
0.22s in isolation (was the largest single concentration of removable waste); suite `duration_ms` 326.6s → 308.5s,
gate 0. The other slowest tests (`broad-day-chain-stress`, `daily-sharded-study-scale`, `judge-experiment-replay`,
`judge-holdout-truth`, `adaptive-store` 1,000-update) are scale / real-composition / real-I-O tests whose magnitude
IS the asserted property (bounded heap at 34,560 rows; linear journal bytes over 1,000 updates), so trimming their
scale would remove coverage — left intact per the acceptance.

## B-5. DONE — 2026-09-16: import-graph sweep; one genuine orphan retired to attic.
A reachability scan (BFS over static + literal-dynamic + worker imports from every runtime entry point — package.json
bin/scripts, fly.js, ui/server.js, bin/*, tools/*, the cpu-lane/decision-memory/case-verify workers, and the
`Run: node <self>` manual entries childhood/build.js + persistence/migrate-local.js) plus a whole-tree importer map found
exactly ONE module with zero importers of any kind (runtime, test, or sibling): `lib/data-only-social-config.js` —
`git mv` to `attic/lib/`, README indexed. Everything else classified as either a tested dormant-by-design subsystem
(imported by tests/reached modules) or a self-contained cluster (barrel + siblings, e.g. adaptive-qualified-procedure,
broad-day-reader) — those have importers and are NOT orphans, so they stay. Attic isolation is already fenced by
`test/attic-fence.test.js` ATTIC-1 (git-ls-files based, so the move is covered). Full suite green + gate 0.

## B-6. DONE — 2026-09-16: persistence boot lines no longer carry a second bracketed prefix.
The boot path's runtime wrapper (`[DATA-ONLY <iso>]` / `[SERPENT PAPER <iso>]`, and fly's `[DATA <iso>]` legacy purge)
owns the ONE bracketed prefix + timestamp; `persistence/runtime.js` was the sole nested wrapper, tagging each startup
line `[boot <bootId>] …` so composed lines read `[SERPENT PAPER <iso>] [boot <id>] …` — TWO prefixes. Its `blog` now
rides the boot-id INLINE (`boot <id>: …`, no bracket), preserving the PUBLISH-FIX-2 duplicate-line disambiguation while
leaving exactly one prefix and one timestamp per line; the scheduleRetry lines were already bracketless, so the boot
path is now uniform. Fence `test/persist-store-runtime.test.js` B-6 boots the real `startPersistence` over a fake DB
driver and asserts every emitted line is prefix-free and that, once wrapped, each composed line has exactly one
`[PHASE <iso>]` prefix (a fake-DB boot repro of the corrected format; no local PG needed). No test pinned the old
`[boot …]` bracket. Full suite green + gate 0.

## B-7. DONE — 2026-09-16: attic/README.md indexes every top-level entry; fence ATTIC-3 enforces it.
Added Contents lines for the previously-unindexed top-level dirs — `docs/` (superseded acceptance/checkpoint notes),
`doctrine/` (retired GOVERNANCE + Meta/TikTok SOCIAL doctrine), `senses/` (the LEAN PASS 4a observation tiers:
discovery / gateway-infrastructure / governance / infra / press / social / video), and a truthful `market-lab/providers/`
line (the retired twelvedata/fred/coinmetrics/deribit/bybit/binance/santiment provider modules, distinct from the LIVE
market-lab/ owner) — each naming what it is and the ticket/law that retired it. `test/attic-fence.test.js` ATTIC-3
reads `attic/`'s top-level entries and asserts each appears in the README, so a future retirement without an index line
fails the fence. Full suite green + gate 0.

## B-8. DONE — 2026-09-16: canonical env NAME registry (docs/serpent/ENV.md) + fence.
The code reads 67 env NAMES (literal `process.env.X` / `env.X` under the living tree); 17 appeared in no doc.
New `docs/serpent/ENV.md` is the canonical registry — every NAME the code reads, grouped, one terse purpose each,
NAMES only never values (secret-valued names listed as NAMES so an operator knows what to provision; values stay in
host Secrets). `test/env-audit.test.js` enumerates the code's literal env reads and asserts (a) every one is registered
in ENV.md or in an allowlist, and (b) ENV.md names nothing the code no longer reads — both allowlists empty today, so
the registry matches the code exactly and a new unregistered read (or a stale registry line) fails the fence. README.md
doc-index points at it. Full suite green + gate 0.

## B-9. DONE — 2026-09-16: pool-slot accounting fenced + documented.
The durable core uses ONE `pg` pool of exactly five connections (`POOL_MAX = 5`, `persistence/db.js`). A session/advisory
-lock HOLDER checks out one slot for the lock's lifetime (long-lived on purpose — the server frees the lock when the
session dies); a caller that LOSES the lock releases its client immediately, so the bounded wait helper
(`acquireSessionLockWithWait`) sleeps holding NO slot and takes one only the instant it wins. Already correct in code;
now fenced. `test/persistence-pool-slots.test.js` drives the real `Db` over a checkout-counting fake pool: pool sized to
five, a holder occupies exactly one slot and a loser none, `release()` returns it, and every wait-helper sleep happens
with zero clients checked out (a waiter never consumes one of the five). Documented in READINESS.md §1 (PostgreSQL pool
slots). Full suite green + gate 0.

## B-10. BLOCKED on R3-2 (parked in OPEN-QUESTIONS.md) — needs an owner decision, so not built.
**Do:** the release manifest from R3-2 (commit/tree hash, build timestamp, node version,
package-lock digest, policy digests, strategy catalog digest, schema version, last suite
result), generated by a tool and carried in `git archive`.
**Acceptance:** as R3-2. Drop this item once R3-2 lands. **Status (2026-09-16):** B-10 IS R3-2, and R3-2 is parked in
`OPEN-QUESTIONS.md` because the manifest's purpose (publish/deploy identity vs review artifact) and its exact required
fields branch on David's design choice — not derivable from docs + doctrine. Skipped per the standing order (a ticket
that needs a human answer goes to OPEN-QUESTIONS and is not guessed). Build once R3-2 is confirmed.

## B-11. DONE — 2026-09-16: the WS idle line is gated on one predicate, silent pre-subscribe.
`market-lab/transport.js`'s idle watchdog logged `ws idle <n> ms — reconnecting` at the idle timeout even during the
expected pre-subscribe quiet window (connected, subscribe sent, first ack/data not yet back). One predicate,
`messagedSinceOpen` (reset on each connection's open, set on the first message), now gates ONLY the log: the watchdog
still reconnects in both cases, but the alarming line is emitted only once data has flowed (a genuine post-subscribe
stall). `test/ws-idle-presubscribe.test.js` drives a scripted fake WS with node:test mock timers through connect →
pre-subscribe idle (silent, still reconnects) → subscribe ack → post-subscribe idle (logs one stall line), and proves
the flag resets per connection. Full suite green + gate 0.

## B-12. Rejection-rate fence — no provider floods identical rejections
**Do:** a fence asserting no provider emits more than 5 identical rejection log lines per
minute (the local paper boot showed a repeated `KRAKEN_DERIVATIVES: record rejected
(observation.quality: …)` line). Either collapse repeats to a once-per-state-change +
count line (the PF1-6 pattern) or rate-limit identical provider rejections, then fence it.
**Acceptance:** a test feeds a provider a burst of identical rejections and asserts at most
5 identical lines/minute reach the log (the rest collapse to a bounded summary); the real
observation is never dropped from the durable record, only the log is bounded; full suite
green + gate 0.

## B-13. Post-PAPER research drafts — DO NOT START UNTIL PAPER IS GREEN
These are research/shadow strategy drafts. **None may begin until PAPER has run green** (a
live paper account observing + deciding, per PAPER-FLIP.md). They are recorded here so the
acceptance bar is written down, not so they are picked up early. Each is SHADOW_ONLY / research
until its own evidence gate clears; none takes decision, sizing or execution authority on the
paper account. (Mirrors the gated queue tickets Strategy 9 GRO, L-3a, R-SRF, L-3b.)
- **GRO — Strategy 9 gate-reopen door-state machine (SHADOW_ONLY).** A door-state machine over
  the gateway matrix (closed → reopening → open) emitting SHADOW candidates only. Acceptance:
  deterministic state-machine test over scripted door transitions; zero Judge/execution authority;
  a fence that GRO reaches no dispatch path; full suite green + gate 0.
- **L-3a — immutable opportunity record (after ≥ PAPER green).** An append-only record of every
  observed opportunity (the candidate + context digest at decision time), never mutated. Acceptance:
  the record is write-once, digest-chained, replayable; a mutation attempt is refused; pure PG test;
  full suite green + gate 0.
- **R-SRF — Supply Replenishment Failure (research/shadow, after Strategy 9 GRO).** A research
  detector for displayed-liquidity replenishment failure after a flush. Acceptance: SHADOW_ONLY
  scoring over recorded book sequences; no live authority; a fence that R-SRF never qualifies a
  live entry; full suite green + gate 0.
- **L-3b — matched discriminator + shadow eval (≥ 2 weeks of L-3a data).** A matched-pair
  discriminator over the L-3a opportunity records with a shadow evaluation. Acceptance: needs ≥ 2
  weeks of L-3a records; evaluation is read-only over the holdout-respecting record; no live
  influence; full suite green + gate 0.

## B-14. Harden the market-lab-owner A09/B02 real-stream re-poll dedup (flake)
**Do:** `test/market-lab-owner.test.js` A09/B02 (STANDALONE owner over real loopback WS +
REST fixtures) intermittently miscounts an identical re-polled source record as a new
observation (seen once as 182 vs 181; passes 3/3 in isolation and on a clean re-run). Make
the re-poll dedup timing-robust so the observation count is deterministic regardless of WS
arrival interleaving — the dedup key must not depend on wall-clock arrival order.
**Acceptance:** the test is deterministic across ≥ 20 back-to-back runs and under the full
concurrent suite (no off-by-one); the dedup is proven by an injected-timing unit case; the
durable observation is never dropped, only the duplicate suppressed; full suite green + gate 0.
