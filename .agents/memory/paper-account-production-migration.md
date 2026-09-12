---
name: Paper account production migration
description: Safety constraint for carrying the authoritative PAPER account into Replit production.
---

The managed development database holds the authoritative PAPER account and its complete chained journal, while production lacks the newer execution and RUMOR2 authority tables.

**Why:** Production also contains substantially more pre-existing memory history than development. Publishing's whole-database overwrite would destroy those production records even though it would copy the account.

**How to apply:** Use a table-specific, non-destructive merge of the missing authority tables through an owner-controlled production import path. Never choose whole-database overwrite. Verify account revision, event sequence and uniqueness, head digest, writer epoch, balance, positions, restrictions, and existing production row counts before starting PAPER.