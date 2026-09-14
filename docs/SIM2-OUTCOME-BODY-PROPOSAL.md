# SIM-2 outcome-body custody — exact additive proposal (AWAITING APPROVAL)

Status: **proposal only — not implemented.** No schema or runtime change lands
until root approves this specific contract. The behavioral target is already
committed as RED tests: `test/daily-simulation-outcome-body.red.test.js`
(6 tests, all failing against current source by design). This file states the
exact files, schema, SQL, store API, quotas, and binding rules that turn those
tests green — nothing more.

Companion finding: `docs/SIM2-EVIDENCE-CONTRACT.md` (why today's rows are
metadata-only). This document is the concrete "how".

## 1. Scope and non-goals

- **In scope:** durably retain a bounded, verifiable *outcome body* per credited
  simulation, readable after restart, so an outcome can be actually replayed.
- **Out of scope / unchanged:** the scheduler, the CAS fence, tally derivation,
  the completed dedupe index, and the "storage grants no learning authority"
  rule. Bodies are *evidence*, still not authority.

## 2. Exact additive schema (migration 11 candidate — root owns the number)

Add ONE table to `PROPOSED_DDL` in `persistence/daily-simulation-schema.js`.
Choose Option A (inline) as the default; Option B (reference) is a later variant.

### Option A — inline bounded payload (default)
```
CREATE TABLE IF NOT EXISTS serpent_dsim_result_body (
  identity        text   NOT NULL,
  day_key         text   NOT NULL,
  sim_id          text   NOT NULL,
  batch_id        text   NOT NULL,   -- the crediting batch (matches completed index)
  content_digest  text   NOT NULL,   -- MUST equal serpent_dsim_result.digest for this sim
  body_bytes      integer NOT NULL,  -- exact byte length of the canonical body
  body            jsonb  NOT NULL,   -- the actual replayable outcome
  PRIMARY KEY (identity, day_key, sim_id))
```
- One row **per credited sim** (keyed like `serpent_dsim_completed`), never per
  raw variant row — bounded by completed count, not by the 4096-row page.
- No index beyond the PK is needed for readback (PK covers point + range reads).

### Option B — external reference (only if bodies are large, e.g. full paths)
```
CREATE TABLE IF NOT EXISTS serpent_dsim_result_ref (
  identity text NOT NULL, day_key text NOT NULL, sim_id text NOT NULL,
  batch_id text NOT NULL, store_kind text NOT NULL, locator text NOT NULL,
  content_digest text NOT NULL, bytes bigint NOT NULL,
  PRIMARY KEY (identity, day_key, sim_id))
```
`locator` names a content-addressed object; the store verifies `content_digest`
on read-back. Same API surface as A; only the storage target differs.

## 3. Exact additive SQL tokens (append to `SQL` + `SQL_BODY`)
```
RESULT_BODY_INSERT : INSERT INTO serpent_dsim_result_body
  (identity, day_key, sim_id, batch_id, content_digest, body_bytes, body)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
RESULT_BODY_GET    : SELECT content_digest, body_bytes, body
  FROM serpent_dsim_result_body WHERE identity=$1 AND day_key=$2 AND sim_id=$3
RESULT_BODY_LIST   : SELECT sim_id, content_digest, body_bytes
  FROM serpent_dsim_result_body WHERE identity=$1 AND day_key=$2
  ORDER BY sim_id LIMIT $3          -- bounded restart read (cap+1 discipline)
RESULT_BODY_COUNT  : SELECT count(*)::int AS n
  FROM serpent_dsim_result_body WHERE identity=$1 AND day_key=$2
```
A bulk-insert prefix `RESULT_BODY_INSERT_BULK_PREFIX` mirrors the existing
result/completed bulk pattern (7 cols/row, same `MAX_INSERT_ROWS_PER_STATEMENT`
chunking and `MAX_INSERT_PARAMS` guard).

## 4. Exact store-API additions (`persistence/daily-simulation-store.js`)

New constructor options (all additive, defaulted):
- `maxOutcomeBodyBytes` (propose **16384** = 16 KiB/sim) — per-body cap.
- `maxBatchBodyBytes` (propose **4 MiB**) — per-commit aggregate cap.
- `requireOutcomeBody` (default **false**) — when true, a credited row without a
  body is refused (`OUTCOME_BODY_REQUIRED`); when false, metadata-only credit is
  still allowed but is **not** counted as replayable (see §6).

`commitBatch(receipt)` — additive rules, enforced BEFORE any write, fail-closed:
1. Each `receipt.resultEvidence[i]` MAY carry `outcomeBody` (a JSON-serializable
   object). A body is only stored for a **newly credited** completed sim
   (same gate as the completed index).
2. `body_bytes = Buffer.byteLength(canonicalStringify(outcomeBody))`. If
   `body_bytes > maxOutcomeBodyBytes` → refuse `OUTCOME_BODY_BYTES_LIMIT`.
3. Sum of `body_bytes` across the batch > `maxBatchBodyBytes` → refuse
   `OUTCOME_BODY_BATCH_BYTES_LIMIT`.
4. **Canonical identity/digest binding:** `contentDigestOf(outcomeBody)` MUST
   equal that row's `digest`; otherwise refuse `OUTCOME_BODY_DIGEST_MISMATCH`.
   (`contentDigestOf` = `sha256:` over canonical `stableStringify` bytes — a real
   content hash, not the store's FNV idempotency digest.)
5. Bodies are written in the SAME transaction as result/completed/CAS, in bounded
   chunks — atomic with the batch; ACK only after COMMIT. A refusal at 2–4
   rolls back the whole batch (nothing written), exactly like existing bounds.

New read methods:
- `readOutcomeBody({ dayKey, simId })` → `{ verified, contentDigest, body }`.
  Verifies stored `content_digest` == `contentDigestOf(body)` before returning;
  a mismatch throws (durable corruption), never returns unverified bytes.
- `loadDay` ledger gains `totals.replayable` and `bodyBackedIds` via
  `RESULT_BODY_LIST` under the SAME `listLimit = maxDayRows + 1` cap+1 overflow
  guard (over cap → LOST, never truncate).

## 5. Readback / restart / replay
- After a restart, `loadDay` reports `totals.replayable` from durable body rows;
  `readOutcomeBody` re-verifies each body against its `content_digest`.
- Replay = read body → recompute/re-score off the body, never off the booleans.
- Bounded: body reads use the cap+1 discipline; a day whose body set exceeds
  `maxDayRows` is LOST (paged restore required), symmetric with completed/pending.

## 6. No learning credit from metadata-only rows (hard rule)
- `totals.completed` stays as-is (accounting): a completed sim is completed.
- `totals.replayable` = count of credited sims with a verified body row. A
  metadata-only completed sim contributes to `completed` but **never** to
  `replayable`. Any learning consumer keys off `replayable`/`bodyBackedIds`,
  so metadata rows can never be mistaken for learnable evidence.
- With `requireOutcomeBody:true`, metadata-only credit is refused outright — the
  strict mode a learning-critical deployment would commission.

## 7. Test plan (already RED; goes green on implementation)
`test/daily-simulation-outcome-body.red.test.js` already encodes:
1. body retained + retrievable + digest-verified;
2. oversize single body refused, nothing written;
3. per-batch aggregate cap refused;
4. body/digest mismatch refused;
5. bodies survive restart within the bounded cap;
6. metadata-only rows excluded from `replayable`.
On approval, add real-PG equivalents (Option A) mirroring the existing
`*.pg.test.js` gating, plus a bounded 100k-with-bodies stress at the 16 KiB cap
to measure real byte throughput and confirm the per-day byte budget holds.

## 8. Dependencies this does NOT remove
This makes the *store* able to hold real outcomes. It does not supply them.
SIM-2 still has **no real executor / job source / market-data source** on this
branch (all injected, synthetic in tests). Real replayable bodies require the
SIM-1 executor + DATA-1 archive reader to be wired and to emit real outcome
bodies with real content digests. Those remain separate, unstarted boxes.
