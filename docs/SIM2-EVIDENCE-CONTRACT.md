# SIM-2 durable evidence — Phase-15 finding and proposed payload/reference contract

Status: **proposal only.** Nothing in this note is implemented. The current
SIM-2 store (`persistence/daily-simulation-store.js`) and schema
(`persistence/daily-simulation-schema.js`) are unchanged by it. This documents
what the durable store *does* retain today, why that is insufficient for actual
replay/learning, and a bounded contract root can weigh before any broader edit.

## Finding: the durable result table is metadata-only

`serpent_dsim_result` (the immutable per-row evidence) stores exactly:

| column | meaning |
| --- | --- |
| identity, day_key, batch_id, row_ordinal | address / ordering (PK) |
| sim_id | opaque simulation identifier supplied by the executor |
| status | terminal/revisitable status string |
| completed / valid_modeled / prospective_eligible | three booleans |
| digest | a fingerprint string supplied by the executor |

That is the whole row. It records **that** a simulation reached a status and
was flagged completed/valid/prospective, plus a fingerprint — it does **not**
record **what happened**: no price path, no realized/modeled P&L, no entry/exit,
no sizing, no feature vector, no decision inputs, no model outputs. `digest` is
used only for content-conflict detection (idempotency), not as a payload.

Consequences, stated plainly:

- **No actual replay.** From the durable evidence alone you cannot reconstruct a
  simulation's outcome, re-score it under a changed rule, or diff two runs. The
  bytes needed to do so were never persisted.
- **No learning authority.** The store already refuses to treat caller booleans
  as proof of a real outcome (`rowContradiction`, evidence-derived tallies).
  The correct reading is stronger: even a *truthful* `valid_modeled=true`
  records a **claim about an outcome, not the outcome**. Counting these
  booleans yields tallies, not learnable evidence.
- **What the tallies are good for.** Reconciliation, dedupe, target/overshoot
  accounting, and restart custody — the scheduler's job. Those are real and
  covered by tests. They are not a substitute for outcome bodies.

So: the SIM-2 durable store is a correct **scheduling/accounting ledger**, and
is **not** a learning corpus. Any box that asserts "autonomous learning that
changes later behavior" (CORE-1/CORE-2) cannot be satisfied by this table.

## Proposed bounded payload/reference persistence contract (NOT implemented)

Two shapes, either of which closes the gap without unbounding the store. Both
are additive and leave every existing integrity guarantee intact.

### Option A — bounded inline payload

Add one immutable, size-capped artifact per credited result:

- New table `serpent_dsim_result_payload(identity, day_key, sim_id, batch_id,
  payload_bytes int, payload jsonb, content_digest text, PRIMARY KEY(identity,
  day_key, sim_id))` — one row per **credited** sim (keyed like the completed
  index), never per raw variant row, so it is bounded by completed count, not by
  the 4096-row raw page.
- Hard caps mirroring the existing receipt bounds: `payload_bytes <=
  MAX_PAYLOAD_BYTES` (propose 16 KiB/sim), and a per-batch aggregate cap so one
  commit cannot write an unbounded blob set. Oversize ⇒ **refuse the receipt**
  (fail-closed), never truncate.
- `content_digest` must equal the executor-supplied `digest` already on the
  result row, so the payload is verifiably the one the digest fingerprinted.
- Written inside the *same* commit transaction as the result/completed rows, so
  it inherits atomicity and the CAS fence; ACK still only after COMMIT.

### Option B — external reference (for large/heavy payloads)

When outcome bodies are large (full price paths), store a **reference**, not the
bytes:

- New table `serpent_dsim_result_ref(identity, day_key, sim_id, batch_id,
  store_kind text, locator text, content_digest text, bytes bigint, PRIMARY
  KEY(identity, day_key, sim_id))`.
- `locator` names an immutable object in an append-only artifact store
  (content-addressed by `content_digest`); the DB row is the bounded index.
- The store verifies `content_digest` on read-back before any consumer trusts
  the referenced body; a missing/mismatched object is a corruption (LOST for
  that day), symmetric with the existing completed/evidence guards.

### Shared requirements (both options)

- **Bounded restart reads.** Payloads/refs are read by the same cap+1
  overflow-detection discipline already used for completed/pending/batches
  (`listLimit = maxDayRows + 1`, refuse past cap) — a restart never streams an
  unbounded body set.
- **Derivation, not trust.** Learning consumers derive from the persisted body
  (or the verified referenced object), never from the caller booleans. The
  booleans stay as they are: a fast index/tally, cross-checked against the body.
- **No new authority in the store.** This still grants no promotion/learning
  authority; it only makes the evidence *sufficient* for a separate,
  explicitly-commissioned learning path to read.

## Recommendation

Do not widen the store yet. Pick A or B (A for compact per-sim summaries, B when
bodies are large) as a **separate, reviewed change** with its own migration
(root owns the migration number) and its own tests, so the scheduling ledger and
the learning corpus stay separable and independently verifiable.
