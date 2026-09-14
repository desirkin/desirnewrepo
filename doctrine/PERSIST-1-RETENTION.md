# PERSIST-1 retention decision — 2026-09-13

David's latest instruction is to preserve all existing sensor history where
possible and retain future sensor recordings indefinitely across republishing.
His acceptance of one-time old raw-data loss is a fallback if recovery is not
possible, NOT an instruction to delete existing history or reset other stores.

## Retention contract

- Future sensor recordings: durable-required, no automatic expiry, pruning, or
  overwrite of acknowledged archival objects. Local cache eviction must never
  imply archive deletion. The former durable-desired proposal is superseded.
- Existing raw sensor history: keep/import what can be recovered without
  discarding the only copy; record missing intervals explicitly. Never fill
  gaps with fabricated measurements or count unsupported studies as valid.
- Balances, control/authorization state, paid budgets, learned state, accepted
  evidence and its original provenance: not covered by raw-history loss consent.
- Raw multi-GB recordings belong in object storage with acknowledged bytes,
  checksums, immutable identities and a durable manifest, not PostgreSQL blobs.
- Store status must distinguish locally pending bytes, archive acknowledgement,
  recovery failure and evidence absence. A database digest without its payload
  is not a backup. No loss claim can be cleared just by creating an empty file.
- Indefinite retention is an operational policy, not a literal guarantee of
  forever: billing, provider/account continuity, access control and verified
  backup/restore remain prerequisites. Do not silently delete on budget pressure.

## Current implementation boundary

The isolated PERSIST-1-1 prerequisite adds a small-snapshot substrate (maximum
1 MiB per exact-text snapshot) with payload+anchor acknowledgement in one PG
transaction, and read-only startup verification of commissioned snapshots.
Older versions are retained; the API contains no delete operation. This is
NOT a raw sensor archive or a backup of every existing local writer.

Owner-specific commissioning, required-store inventory, restore/migration
adapters and bulk object storage are still pending. An empty anchor table is
reported UNCOMMISSIONED, never proof that all stores are new or protected.
Do not activate automatic learning or call future sensor storage durable on
the strength of these tests alone. No production migration or publish-and-
restore experiment has yet been performed for this branch.

The handoff's one-ticket-at-a-time/report checkpoints remain in force. The
running collection, trade mode, enables and account configuration are unchanged.
