# Serpent backlog — no-decision tickets

Ordered list of work that needs NO human decision. Each item carries its own
acceptance criteria. When the main queue is empty, pull the top item here; never
hold idle while an unblocked item remains. Extend this list whenever no-decision
work is noticed. A ticket that turns out to need a human answer is written to
`OPEN-QUESTIONS.md` and skipped — never parked-and-waited-on here.

Standing order and how the queue/backlog/open-questions relate: `docs/serpent/README.md`.

---

## B-1. Lean pass 4 — Prettier on all non-frozen code
**Do:** add a repo Prettier config that matches the house style as closely as is
automatable, then format every tracked `*.js`/`*.mjs` that is NOT a frozen-core file.
**Never touch:** any file pinned by a byte/digest fence (the SCOPE-8 protected set in
`test/social-4f-scope.test.js`, `judge/`-focused byte fences, `persistence/migrate.js`
HEAD pins, and any REPINNED digest). Confirm the pinned set first and exclude it.
**Acceptance:** full suite green + offline gate 0; every byte/digest fence still passes
(proving no frozen file moved); the diff is formatting-only (no token changes) on the
files touched; the Prettier config is committed so the format is reproducible.

## B-2. L-2 follow-up — 24h maturation pass
**Do:** the maturation pass that fills the 1h/4h/24h outcome columns of the research /
opportunity records once each horizon has elapsed (the columns L-1/L-2 left pending).
**Acceptance:** a recorded decision older than each horizon gets its 1h/4h/24h outcome
filled from the actual tape; a decision younger than a horizon leaves that column
explicitly pending (never a fabricated zero); pure/deterministic test with injected
clock + tape; full suite green + gate 0. Feeds R3-6 (weekly report) columns.

## B-3. BASELINE.md + READINESS.md refresh after the cull
**Do:** update `docs/serpent/BASELINE.md` and `docs/serpent/READINESS.md` to reflect the
post-cull tree (retired social ears, the TwelveData / CROSS_ASSET market-lab cut, family
count 16, provider count 18, app line count).
**Acceptance:** no retired provider/family/sense named as live; the family/provider
counts and app-line figure match the code; full suite green (docs are not test-read, so
this is a truthfulness pass, not a fence change).

## B-4. Test-time trims — the ten slowest tests
**Do:** measure per-test wall clock (`node --test` timings), take the ten slowest, and
cut their runtime without losing coverage (shrink fixtures, drop real sleeps for injected
clocks, reduce redundant iterations).
**Acceptance:** each trimmed test asserts the same behavior (no removed assertions); the
suite's total wall clock drops measurably; full suite green + gate 0.

## B-5. Orphan sweep — zero-importer modules to attic
**Do:** find every living-tree module with zero non-test importers (and no runtime entry
point / CLI / composition-root reference), and `git mv` each to `attic/` (never delete),
removing it completely from the living tree.
**Acceptance:** an import-graph scan shows no living module is unreferenced after the
sweep; nothing in `attic/` is imported by living code; full suite green + gate 0.

## B-6. Boot-log consistency — one prefix, one timestamp per line
**Do:** make every boot log line carry exactly one prefix and one timestamp (today's logs
print two on some lines). One logger shape across the boot path.
**Acceptance:** a boot-log fence asserts each emitted boot line matches the single-prefix,
single-timestamp shape; the local fresh-DB boot repro shows the corrected format; full
suite green + gate 0.

## B-7. attic/README.md index
**Do:** write `attic/README.md` listing what is in the attic and why — one line each
(module/dir → the ticket/law that retired it).
**Acceptance:** every top-level entry under `attic/` appears in the index with a reason;
a small fence asserts the index covers the attic's top-level entries; full suite green.

## B-8. Env-var audit
**Do:** cross-check environment variable NAMES referenced in docs against those read by
code, both directions — names in docs but not code, and names in code but not documented.
Reconcile (document the real ones, drop the stale doc references). NAMES only, never values.
**Acceptance:** a fence enumerates env NAMES read by code and asserts the doc set matches
(or an allowlist explains each intentional difference); full suite green + gate 0.

## B-9. Pool-slot accounting
**Do:** document and test that session/advisory locks each hold one of the five PostgreSQL
pool slots; make the count explicit and fenced.
**Acceptance:** a test asserts the pool size and that concurrent lock holders never exceed
the slot count (with the wait helper, a waiter does not consume a slot while sleeping);
documented in READINESS.md; full suite green + gate 0.

## B-10. RELEASE.json (only if R3-2 has not landed)
**Do:** the release manifest from R3-2 (commit/tree hash, build timestamp, node version,
package-lock digest, policy digests, strategy catalog digest, schema version, last suite
result), generated by a tool and carried in `git archive`.
**Acceptance:** as R3-2. Drop this item once R3-2 lands.
