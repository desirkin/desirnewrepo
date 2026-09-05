# RUMOR-2 — Doctrine

WIDE EARS. NARROW TEETH.

RUMOR-2 IS A MULTI-SOURCE EVIDENCE SYSTEM.

IT IS NOT THE SAME THING AS STOCKTWITS RUMINT.

The existing StockTwits RUMINT ear (RUMINT-R1B) keeps polling, keeps its
z = 3 threshold, keeps nominating, keeps HYPED — untouched. RUMOR-2 is a
NEW dark intelligence layer beside it. Its central product is not "count
more posts"; it is the chain:

SOURCE → CLAIM → ORIGIN / SUPPORT / ECHO / CONTRADICTION / RETRACTION →
TIMELINE → POINT-IN-TIME EVIDENCE PACKET → future Socrates.

## Permanent rules

A CLAIM IS NOT A FACT.

AN ECHO IS NOT CORROBORATION.

ONE SOURCE IS ONE SOURCE.

OFFICIAL PRIMARY EVIDENCE DOES NOT CREATE TRADING AUTHORITY.

PROVIDER ABSENCE IS NOT NEGATIVE EVIDENCE.

UNOBSERVED IS NOT ZERO.

RUMOR-2 IS DARK.

RUMOR-2 DOES NOT TRADE.

NO IDEA BECOMES TRUE BECAUSE MANY PEOPLE REPEAT IT.

WE ARE NOT BUILDING A PUMP FILTER.
WE ARE BUILDING A PUMP-STAGE DETECTOR.

And the Socrates boundary stands whole:

"I interpret evidence. I do not create truth."

## RUMOR-2A — what exists now

`rumor2/` is the nervous tissue every later ear plugs into:

- **truth.js** — pure core: bounds, semantic source identity, deterministic
  coin resolution and claim classification, point-in-time clocks, strict
  checkpoint validation, cooldown ladder.
- **feed.js** — strict bounded RSS/Atom item extraction. Feed XML is
  hostile input: DOCTYPE, entity declarations, and XInclude are rejected
  outright; there is no entity resolution, no remote schema fetch, no
  script execution; item counts, titles, and summaries are hard-bounded.
  It is deliberately a narrow fail-closed scanner, not a general XML
  parser — the project's standing zero-dependency rule (`pg` only) makes
  an in-repo bounded extractor the safer choice over a new package, and
  anything it cannot recognize is rejected, never guessed at.
- **http.js** — the guarded fetch: fixed per-provider HTTPS host
  allowlists; http/file/ftp, localhost, loopback, private and link-local
  targets rejected; redirects bounded (2) and only within the provider's
  own allowlist; 5-second timeout; 1 MiB body cap enforced by stream,
  never trusted from Content-Length; ETag/If-None-Match and
  Last-Modified/If-Modified-Since used where the server offers them — a
  truthful 304 is a SUCCESSFUL observation with zero changed bytes.
- **registry.js / providers/** — the closed set of ears. RUMOR-2A wires
  ONLY verified official primary sources:
  `KRAKEN_OFFICIAL` (blog.kraken.com/feed — EXCHANGE_OFFICIAL/OFFICIAL),
  `SEC_OFFICIAL` (www.sec.gov/news/pressreleases.rss — REGULATOR/OFFICIAL),
  `CFTC_OFFICIAL` (www.cftc.gov/RSS/RSSGP/rssgp.xml — REGULATOR/OFFICIAL).
  Each endpoint was verified first-party over HTTPS. No mirror, no
  search-engine cache, no third-party RSS generator — an unverifiable
  provider is truthfully NOT_SUPPORTED/NOT_QUERIED, never quietly
  replaced. The SEC ear runs only when a contact is configured
  (`SERPENT_HTTP_CONTACT`); Serpent never invents a contact and never
  impersonates a browser. Item links inside feeds are NEVER crawled in
  2A — the official listing response itself is the evidence.
- **graph.js** — the bounded deterministic claim graph: one claim node per
  (claimType, canonicalCoin), explicit origin/support/echo/confirmation/
  contradiction/retraction source sets, one deterministic provenance group
  per organization. Structural status only: an OFFICIAL publication that
  itself asserts the claim is PRIMARY_CONFIRMED (a primary announcement
  does not need two witnesses); nothing in 2A can ever be CORROBORATED,
  because one organization is one provenance family and one family cannot
  corroborate itself.
- **packet.js** — the only exit toward future Socrates. It speaks
  serpent-evidence-1 through the accepted contract's own helpers and
  validator, invents no schema version and no trigger kind
  (trigger.kind = RUMINT_CLAIM), and enforces producer sub-bounds far
  below the contract's outer caps (claims 6, sources 12, evidence 24,
  claimLinks 32, contradictions 8, missingEvidence 8, raw excerpts 3,000
  chars). Every packet passes `validateEvidencePacket()` BEFORE it may be
  recorded as valid; failures are WITHHELD with bounded reasons, never
  fixed up.
- **collector.js** — orchestration: injectable cadence (Kraken 60 s, SEC
  120 s, CFTC 120 s) under hard hourly request ceilings (90/45/45),
  per-provider independent health and bounded exponential backoff
  (60 s → 2 m → 4 m → 8 m → 15 m, capped 30 m; 429 honors bounded
  Retry-After), durable checkpoint (schema migration 5,
  `serpent_rumor2_checkpoint`) validated strictly on restore — a corrupt
  checkpoint is WITHHELD, never silently fresh-started over; a missing one
  is an honest FRESH_START. Crash law: SOURCE EVIDENCE IS APPENDED TO THE
  DURABLE EVENT STREAM BEFORE THE CHECKPOINT MAY REMEMBER IT AS SEEN, and
  a replay after a crash collapses in canonical Memory through its exact
  semantic sourceEventId. A failed append never advances seen-state. A
  durable-core outage degrades RUMOR-2 (FAILED_DURABILITY) without
  touching Tape, Wide Eye, RUMINT, or MICRO.

## Crash law and propositions (RUMOR-2A1)

ONE SOURCE ITEM MUST SURVIVE A CRASH AS THE SAME KNOWLEDGE EVENT.

AN EVENT THAT FAILED TO PERSIST MAY NOT BE REMEMBERED AS COMPLETE.

A CLAIM TYPE IS A CATEGORY. IT IS NOT A PROPOSITION.

Before any truth-bearing event from a new official item may append, a
bounded immutable ITEM TRANSACTION — the exact prepared events with their
original clocks, packetIds and semantic identities, plus the candidate
checkpoint state — is persisted durably (WRITE AHEAD). Recovery settles
the owed transaction before any new polling: each exact event is proven
present in the bounded stream tail (RECONCILE_TAIL_BYTES = 1 MiB) or the
exact prepared record is appended — retrievedTs, knownAtTs, asOfTs,
packetId and sourceEventId are NEVER regenerated, so a crash replay is
the same knowledge event with the same canonical Memory identity. Seen
state, graph state, and counters adopt the candidate exactly once, only
when the COMPLETE bundle (source, claim, packet, withheld) is durably
settled; a failed append retains the whole transaction, halts new
polling, and is truthfully exposed as `pendingTransaction`.

Cursor law (A2): NO PROVIDER RESPONSE CURSOR MAY BECOME DURABLE BEFORE
EVERY ITEM SERPENT INTENDS TO CONSUME FROM THAT RESPONSE IS DURABLY
SETTLED. A response cursor is anything that could make a later request
suppress the original response — ETag, Last-Modified, bootstrap-complete
state — and it is held locally through item processing, committing to the
checkpoint only after the last selected item settles; per-item write-ahead
saves always carry the OLD cursor, so a failed item forces a full
re-fetch in which settled siblings dedupe by semantic identity and
nothing can vanish behind a 304. Provider OBSERVATION truth
(lastSuccessTs, health resets) is separate from cursor-CONSUMPTION truth
and stays immediate — coverage never lies in either direction. Trust law
(A2): a persisted prepared transaction is replayed verbatim on restart,
so it is a CLOSED semantic schema proven before recovery may touch it —
exact keys, causal clocks, the four allowed event types only, every event
bound to its source item and proposition, every prepared packet
re-validated under serpent-evidence-1 (a fabricated packet withholds the
ear instead of becoming KNOWN Memory), and counter deltas corresponding
one-for-one to the prepared bundle. Internally consistent forgery is not
provenance (A2R): the source identity is RECOMPUTED from immutable
identity facts preserved in the transaction, every truth-bearing event is
an exact-key closed shape, and candidate seen/graph state must be the
deterministic consequence of prior durable truth plus this exact bundle —
re-derived through the one shared pure transition, never asserted. THE
BUNDLE ITSELF MUST BE TRUE: the prepared events are a semantic SET, not a
list of individually plausible records — one source observation, at most
one claim per proposition, exactly one packet-XOR-withheld outcome per
proposition, each packet identity at most once, and a coin-resolution
withholding exclusive of any resolved claim path for the same item.
Counter deltas are DERIVED from that proven-unique bundle; a delta may
never legitimize a duplicated or self-contradictory bundle. Memory
deduplication downstream is a safety net, never permission to append
duplicate or mutually contradictory raw truth — internally consistent
contradiction is still contradiction.

Graph nodes are PROPOSITIONS: `r2c-` identities over (claimType,
canonicalCoin, origin sourceObservationId). Two unrelated enforcement
actions about one coin are two claims; the same official item — repeated,
replayed, or restarted — is always the same proposition; a contradiction
or retraction attaches only to the exact proposition it targets, never
found by type+coin search. RUMOR-2B may attach a source to an EXISTING
proposition only when it can prove sameness. Checkpoint v2 carries the
transaction slot and proposition-keyed graph; an obsolete checkpoint
fails closed (RUMOR-2 was never published, so no production truth
migrates).

## Point-in-time truth

Every source observation distinguishes `publishedTs` (the publisher's
stated clock), `retrievedTs` (when Serpent fetched), and `knownAtTs`
(when Serpent actually knew). knownAtTs is NEVER backdated: a bootstrap
that reads last month's archive learned about it tonight, period. A
future publication timestamp is rejected. This is what makes later
forward testing honest.

## Identity

Source identity is semantic and immutable: provider + official guid +
canonical link + published clock + content hash. Retrieval time is never
identity. The same official item fetched tomorrow is the SAME source
observation; changed material content is a NEW observation that never
impersonates the old truth.

## Coin resolution

Never fuzzy. A ticker binds only as an exact standalone uppercase token
from the canonical universe; a name binds only through the approved
unique alias table (BITCOIN→BTC, ETHEREUM→ETH, SOLANA→SOL,
DOGECOIN→DOGE; "Ripple" is deliberately NOT an alias for XRP). Ambiguity
retains the source observation and withholds resolution — no
coin-specific packet is invented. One multi-asset official article keeps
ONE shared source identity with one claim path per unambiguous coin.

## Deterministic only

No LLM anywhere in RUMOR-2A. Classification uses closed pattern tables
over provider identity, titles, and bounded summaries; when no pattern
establishes a type, no typed claim exists. External titles, summaries,
and excerpts are hostile DATA — bounded, content-hashed, marked
`untrusted: true` in packets, and never interpreted as instruction, no
matter what characters they contain.

## RUMOR-2B1 — official primary-evidence ears (EDGAR + OFAC)

RUMOR-2B1 adds two DARK official-primary-evidence ears to the closed
registry. Both are EVIDENCE ONLY and DARK ONLY: zero Attention authority,
zero HYPED authority, zero stalking, zero trading authority, no Socrates
or model runtime, no prompt interpretation, no sentiment. They observe and
record; they never act. Both default OFF and arm only through explicit
environment gates; a public source does not mean "always on".

- **EDGAR_OFFICIAL** — SEC EDGAR primary filings through the SEC's own
  documented machine-readable API
  (`data.sec.gov/submissions/CIK##########.json`, per the official "EDGAR
  application programming interfaces" documentation), behind a configured
  CIK whitelist and form whitelist (`RUMOR2_EDGAR_ENABLED`,
  `RUMOR2_EDGAR_CIKS`, `RUMOR2_EDGAR_FORMS`; contact-bearing User-Agent
  required, like the existing SEC ear). The accession number is the
  filing's immutable identity: restarts, repolls, and reordered responses
  are the SAME observation; an amendment is a DISTINCT filing. A form type
  is evidence metadata, never a conclusion — the deterministic classifier
  has no pattern table for filings, so no typed claim, no coin, and no
  proposition is ever invented from one. UNRESOLVED ENTITY-LEVEL EVIDENCE
  IS A VALID RESULT; false certainty is not.

- **OFAC_OFFICIAL** — the U.S. Treasury / OFAC SDN list through the
  official Sanctions List Service
  (`sanctionslistservice.ofac.treas.gov/api/download/sdn.csv`, per
  ofac.treasury.gov; the service's one redirect to Treasury's fixed
  publication bucket is pinned as an explicit closed allowlist), behind
  `RUMOR2_OFAC_ENABLED`. Deterministic snapshot/diff: the first accepted
  dataset is a BASELINE (one bounded observation — bootstrap is never an
  event explosion), later datasets yield explicit ADD / MODIFY / REMOVE
  evidence, and an order-immune dataset identity makes replayed or
  reordered downloads the same knowledge. Digital-currency addresses are
  preserved EXACTLY as the official record supplies them — never
  lowercased, re-encoded, or expanded into wallets, clusters, or
  ownership. OFAC TRUTH, NOT BLOCKCHAIN ATTRIBUTION, and never an
  automatic market conclusion. A malformed, truncated, or
  mass-deleting dataset is refused whole — accepted truth is never erased
  by one HTTP 200.

Point-in-time law binds both ears absolutely: SOURCE TIMESTAMP IS NOT
SERPENT KNOWLEDGE TIMESTAMP. A filing accepted at 10:01:12 that Serpent
first fetched at 10:01:19 is known at 10:01:19; a backfilled record is
known when it was actually acquired, never earlier. Both ears flow through
the ONE authoritative prepared-transaction trust boundary (the same
validator at restore and settle) — and that validator now also re-derives
the claim TYPE from the preserved facts through the same closed pattern
tables, so an unclassifiable item can never smuggle a typed claim or a
coin-resolution withholding into its bundle. EDGAR and OFAC are separate
source families (`US_SEC`, `US_TREASURY_OFAC`); a downstream article
repeating both is echo, not corroboration.

Closeout hardening (B1 certification):

- THE ATTEMPT DEADLINE BOUNDS THE WHOLE OPERATION. One watchdog covers
  connection, redirect hops, headers, AND full body consumption — headers
  arriving is not completion, and a 200 whose body stalls terminates
  exactly like a hung connection, adopting zero items, zero truth, zero
  snapshot, zero cursor, zero provider success.
- ONE SEC FILING IS ONE LOGICAL SOURCE OBSERVATION. EDGAR identity-bearing
  content derives ONLY from immutable filing facts (CIK, accession, form,
  filing/acceptance clocks, stated items, primary document, archive link);
  the issuer's mutable current display name is excluded, so a company
  rename can never manufacture a new filing, while the recomputed identity
  still binds every preserved immutable fact against forgery.
- AN OFAC CHANGE IS A TEMPORAL TRANSITION, not a record state. Its
  identity binds the prior accepted snapshot's monotonic sequence number
  (the causal clock of accepted snapshots) plus uid, change type, and the
  prior/new record hashes — no wall clock, no randomness. Retries and
  crash replays of the same owed transition derive the same identity;
  a recurrent dataset state (A -> B -> A -> B) is a NEW transition.
- PROVIDER STATE IS A CLOSED SCHEMA OVER A CLOSED SET. Exactly the
  enumerated base fields, no undeclared extras; the snapshot anchor is
  legal on the OFAC ear alone; and the provider map must be either the
  complete current registry or EXACTLY the pre-B1 legacy trio (which
  restores with the B1 ears born fresh) — any other subset lost durable
  truth and fails closed.

Truth-boundary closeout #2 (final seal):

- STRUCTURALLY MALFORMED IS NOT UNKNOWN. An EDGAR response whose required
  identity-bearing columns are missing, misaligned, wrong-typed, or
  unparseable is rejected WHOLE — corruption is never converted into
  legitimate-looking unknown information, so a partial document can never
  mint a second identity for the same filing. UNKNOWN is only the SEC's
  own legitimate empty value. primaryDocument is a safe SEC archive
  locator or empty: no traversal, no absolute or protocol-relative URL,
  no query/fragment, no control characters, no escape from the filing's
  own archive directory.
- THE OFAC SNAPSHOT CACHE IS NEVER TRUTH AUTHORITY. It stores uid + prior
  row hash and nothing else, and is trusted only after re-deriving the
  COMPLETE durable checkpoint anchor (hash and record count). REMOVE
  evidence names the record by its authoritative uid and anchored prior
  row hash — no cached display text can ever be quoted into a truth
  event. Truth integrity beats pretty text.
- THE GRAPH IS TRUTH, SO THE GRAPH IS VALIDATED. One authoritative graph
  validator, at both gates: closed container and node schemas, proposition
  identity and normalizedSubject re-derived, STATUS derived from relation
  arrays (never trusted — the unreachable CORROBORATED can never ride in),
  observation providers pinned to the registry with source-only ears
  (EDGAR, OFAC) refused as claim evidence, relation kinds closed, and all
  graph clocks causal and at or before the checkpoint's own clock.
- THE WHOLE CHECKPOINT IS CLOSED. Top-level fields, counters, providers,
  graph, and transaction are all exact schemas; durable truth can never
  claim future success, future snapshot acceptance, future preparation, or
  decades of backoff; persisted ETag/Last-Modified obey the same bounds
  runtime adoption enforces, with no header-injection characters.
- NO AMBIGUOUS LEGACY RESTORE. Only the complete current provider set
  restores. The historical pre-B1 trio is structurally indistinguishable
  from a current checkpoint that lost both B1 ears, so it is recognized
  and truthfully WITHHELD as incompatible — reviving an elder developer
  checkpoint is an explicit offline operator migration, never automatic
  runtime inference.
- HTTP bounds are BYTES, not characters, on every path; abandoned response
  bodies (redirects, 429, other non-success) are cancelled fire-and-forget;
  and only the exact official HTTPS origin is ever spoken to — no
  alternate ports, no embedded credentials.

Derived-truth closeout #3 (the freeze seal):

- DERIVED STATE MUST NOT AUTHENTICATE ITSELF. The append-only settled
  event stream (the durable event journal since closeout #4; formerly
  rumor2/events.jsonl, now the best-effort mirror) is the
  authoritative causal record; the checkpoint's graph, counters, and seen
  state are DERIVED caches of it. On every restore, ONE pure replay walks
  the settled events in actual settlement order — through the SAME
  production transitions live settle uses (rememberSeen, observeClaim /
  deriveTxnGraphDelta, the same counting and uniqueness laws) — and the
  persisted derived caches are proven against it. The still-owed
  transaction's events are excluded from replay: they are appended-but-
  unadopted truth the A1 settle gate adopts, which is exactly the
  watermark that makes the comparison unambiguous.
- THE GRAPH MUST EQUAL ITS REPLAY. A fabricated contradiction, an erased
  confirmation, rewritten claim text, rewritten observation text or
  clocks, or swapped provenance groups — however internally consistent —
  is a GRAPH_REPLAY_MISMATCH and the store is WITHHELD. Replayable
  counters must equal their replay (COUNTER_REPLAY_MISMATCH otherwise);
  the duplicates tally counts suppressed re-observations that append no
  event by design and stays a bounded non-authoritative operational
  number. Graph and counters are never rebuilt by guessing: a mismatch
  cannot distinguish a forged checkpoint from a truncated log, so it
  withholds.
- SEEN STATE IS DERIVED ON RESTORE. providers.*.seenIds never carries its
  own authority: replay of SETTLED source observations (pending, failed,
  or unsettled work never counts) derives the canonical per-provider FIFO
  through the same rememberSeen law, and that derivation IS the restored
  seen state — the checkpoint copy is only an integrity diagnostic
  (SEEN_STATE_REBUILT is reported when it lied). A fabricated seen id can
  therefore never suppress real future evidence, and a deleted one can
  never mint duplicate truth.
- REPLAY IS DETERMINISTIC AND POINT-IN-TIME HONEST: settlement order
  only, never publication order; timezone- and process-independent; the
  exact live (type, sourceEventId) uniqueness law absorbs crash
  re-appends; a claim event must follow its own settled source and come
  from a claim-capable ear, so replay can never manufacture authority
  live production forbids. A corrupt event line fails the history closed
  (EVENT_HISTORY_INVALID); only a torn FINAL line — the legitimate
  crash-window artifact — is tolerated.

Event-root seal, closeout #4 (the root of truth itself):

- THE EVENT HISTORY IS THE ROOT OF TRUTH, SO THE EVENT HISTORY IS
  VALIDATED AND DURABLE. A root of truth cannot be considered
  authoritative if it can disappear independently of the checkpoint that
  depends on it: the authoritative event journal therefore lives in the
  SAME durable core as the checkpoint (PostgreSQL, serpent_rumor2_events —
  append-only rows under one monotonic contiguous per-stream sequence,
  INSERT-only, no UPDATE/DELETE path in the repository at all). The local
  rumor2/events.jsonl survives ONLY as a best-effort mirror/export feeding
  the Memory tail: a mirror write failure never rolls back authoritative
  truth, and a missing or forged mirror file affects nothing.
- ONE AUTHORITATIVE EVENT VALIDATOR. No replay branch trusts event.type
  alone. Every event type the stream may carry — SOURCE_OBSERVED,
  CLAIM_OBSERVED, PACKET, both WITHHELD variants, the pre-transaction
  clock refusal, PROVIDER_FAILURE, STARTED — has a closed exact-key
  schema; unknown types and undeclared fields fail the history closed.
  Source events carry their COMPLETE identity-bearing facts (the full
  bounded summary, not an excerpt), and the r2s identity must be the
  recomputed semantic hash of exactly those stored facts — never a hash
  stored beside them, never trusted from its shape. Clock laws hold per
  event (published <= retrieved <= knownAt; the event stamp IS its
  knowledge clock). Claim events re-derive their proposition identity,
  their claimType as the deterministic classification of the stored
  source facts, and their coin from the text under the exact resolution
  law; their status must equal derived node truth. Packet events
  re-validate under serpent-evidence-1 AND must equal, byte for byte,
  what the production builder derives from settled node truth at that
  point of the replay — a forgery that recomputes every identity still
  dies against the builder.
- THE DUPLICATE LAW IS DECISIVE. One identity, one truth: a
  byte-identical re-append of a (type, sourceEventId) identity is the
  legitimate crash window and collapses to one knowledge event — at the
  replay, at the journal door, and in the schema (a partial unique index
  pins each truth-bearing identity to one durable payload); the same
  identity over an ALTERED payload is corruption, refused whole, never
  resolved by picking first or last.
- THE WATERMARK MAKES RECONCILIATION DETERMINISTIC. Checkpoint v4 names
  how far settled truth extends in the journal (lastSettledEventSeq). A
  journal that ends before the watermark lost history the checkpoint
  depends on: WITHHELD (EVENT_HISTORY_MISSING), never guessed over.
  Truth-bearing events beyond the watermark must belong to the still-owed
  write-ahead transaction (appended-but-unadopted truth the A1 settle
  gate adopts exactly once); an unexplained tail is corruption. Settle
  appends the whole prepared bundle as ONE atomic journal batch — a
  refused batch advances ZERO truth and the transaction stays owed.
- THE CHECKPOINT IS A CACHE OF THE JOURNAL, NEVER THE REVERSE. A missing
  checkpoint over a valid non-empty journal REBUILDS the derived caches
  from the authority (REBUILT_FROM_EVENT_HISTORY) — no fresh start over
  existing truth, no history loss, no re-minted evidence (the
  non-replayable duplicates tally honestly restarts at zero). Only both
  absences together are an honest FRESH_START. Old checkpoint versions
  (v3 and earlier) describe a materially different authority model and
  are WITHHELD for explicit operator migration, never reinterpreted.
- NO HASH CHAIN, BY EXPLICIT DECISION. Every truth-bearing event is
  semantically self-authenticating (identities re-derive from stored
  facts, packets re-derive through the builder), the database enforces
  sequence and identity uniqueness structurally, and the restore gate
  binds checkpoint to journal by full semantic replay — a chain would add
  tamper-evidence only against an adversary with durable-core write
  access, who could rewrite any chain lacking an external trust anchor;
  reorders and edits that change settlement truth already change the
  graph or counters and are refused, and packet providerCoverage remains
  recorded runtime health with zero truth authority.

Roadmap unchanged: RUMOR-2B may later add authorized social ears and
propagation reasoning; SOCRATES remains separate; GHOST remains separate;
derivatives and on-chain senses remain separate. None of those exist yet.
The SEC_OFFICIAL / EDGAR_OFFICIAL common-organization provenance question
(one U.S. SEC, two provider ids) remains reserved for RUMOR-2B propagation
work: it is inert today because filings can produce no claims, and a
regression drill pins that inertness.

## What RUMOR-2A is not

No X. No Reddit. No Reuters/Bloomberg/CNBC/FT/CoinDesk/any publisher. No
item-link crawling. No Socrates call, no model, no prompt, no key. No
GHOST. Zero Attention weight, zero HYPED authority, zero stalking, zero
eligibility, zero Brain, zero STRIKE, zero execution. Those boundaries
are enforced by tests, not comments.

## RUMOR-2 IS FROZEN

Final freeze seal — the last closeout pass. RUMOR-2's source, claim,
packet, event, journal, checkpoint, graph, seen-state, counter, coverage,
durability, and writer-authority contracts have all passed closeout. This
layer has earned stability.

FROZEN means: stable, a trusted foundation — no casual refactors, no silent
schema expansion, no new provider becomes claim-capable by default, no new
event type is accepted by replay by default. Any future extension requires
an explicit, versioned ticket with its own tests. FROZEN does NOT mean
abandoned, disabled, or finished-as-a-product — it means good to go, and
safe to design the next Serpent layer on top of.

Sealed at this pass:

- PROVIDER HEALTH IS NOT EVIDENCE. providerCoverage records what Serpent's
  ears were DOING at packet-build time (OBSERVED / FAILED / NOT_QUERIED /
  STALE). It is OPERATIONAL DIAGNOSTIC metadata, classified as such in the
  frozen PACKET_FIELD_SEMANTICS contract, and it can never satisfy an
  evidence requirement, count as corroboration or independent support,
  change a claim or graph status, or alter proposition identity. "A
  provider was reachable" is not "a provider supplied evidence." Support,
  corroboration, independence, and provenance derive ONLY from the settled
  evidence structure — sources, claimLinks (their relation kinds and
  independence groups), and evidence items — which already records which
  providers actually contributed evidence (the providers of the referenced
  sources). A future Socrates must read evidence there, never from provider
  health. providerCoverage is a full-snapshot field of the immutable
  packet, so it participates in packetId (which identifies the complete
  point-in-time snapshot, diagnostics included) but in no evidentiary
  identity: a coverage change yields a different snapshot id while every
  evidentiary member — claims, sources, evidence, claimLinks, subject,
  statuses, independence groups — stays byte-identical, so it changes zero
  evidentiary truth and cannot reach Attention, HYPED, eligibility, score,
  sizing, or execution.

- ONE ACTIVE RUMOR WRITER, ENFORCED LIVE. In the durable core, journal-writer
  authority is fenced by a session-scoped PostgreSQL advisory lock held for
  the active collector's lifetime. A second collector cannot acquire it: it
  stands by (lifecycle STANDBY_WRITER) and performs zero fetches, zero
  appends, zero checkpoint writes, zero packets — read-only status
  inspection at most. The server releases the lock automatically when the
  winning session dies (crash, connection loss, termination), so the next
  collector takes over safely with no lease bookkeeping; a rightful restart
  restores from journal + checkpoint exactly, with no truth duplication.
  Lock recovery never touches the journal sequence.
  The advisory lock alone leaves a cross-session time-of-check/time-of-use
  gap — the lock is held on one session while checkpoint and journal writes
  run on other pooled sessions, so a lock lost mid-write could still let a
  delayed cross-session write commit. So the DATABASE enforces the fence too:
  a monotonic per-stream WRITER EPOCH (serpent_rumor2_writer_epoch) advances
  by one on every acquisition (only a process that already holds the advisory
  lock advances it; a failed contender never does; it never rewinds). Every
  authoritative RUMOR mutation — the checkpoint upsert and the journal append
  — verifies current_epoch == the caller's epoch INSIDE the same database
  transaction that performs the write, taking the epoch row FOR UPDATE so a
  concurrent acquisition serializes against it. A stale writer is rejected by
  PostgreSQL at the mutation boundary (STALE_WRITER): it consumes no event
  sequence, writes no rows, and can never overwrite a newer writer's
  checkpoint (no unconditional last-write-wins upsert remains). The checkpoint
  and journal thus have no cross-session TOCTOU. Events and checkpoints
  written under an OLD epoch stay valid history — the epoch governs only NEW
  writes, never restore or replay — so a legitimate crash tail from a prior
  epoch is recovered and an owed transaction is settled by the next writer
  under its own epoch. If the epoch cannot be established or confirmed, the
  mutation fails closed — safety over liveness, never a fall back to a cached
  application boolean. The writer epoch is a persistence-authority mechanism
  only: it carries zero evidentiary or trading authority.
  Writer authority is checked LIVE, never trusted from a boolean captured
  when the tick began: NO RUMOR DURABLE MUTATION MAY BEGIN OR COMPLETE
  unless the collector currently holds the fence. The live check runs at
  every truth-changing boundary — after each awaited provider fetch, before
  the write-ahead save, before the journal append, before adopting the
  appended bundle, before every checkpoint save, and before OFAC snapshot
  adoption. A fence lost mid-tick halts the tick and drops to standby with
  no further provider processing; status never keeps reporting ACTIVE after
  a failed live check; and uncertainty (a fence the database cannot confirm)
  fails closed — safety over liveness. If the fence dies in the window after
  a journal batch has durably committed but before the collector adopts it,
  the collector does NOT adopt: the journal-ahead tail is left for the next
  legitimate writer's event-root recovery, never compensated or double-
  applied. The durable journal enforces this too — its append refuses to
  allocate a sequence or write a row (WRITER_FENCE_LOST) unless the fence is
  held, so no collector bug and no direct call can bypass one-writer.

- LOCAL DURABILITY IS EXPLICIT AND LABELED. The local events.jsonl file is
  honest development/research storage, never deployment-grade durability,
  and it NEVER activates by silent fallback: a missing durable journal
  without the explicit RUMOR2_ALLOW_LOCAL_JOURNAL opt-in (or an injected
  journal, explicit by construction) is FAILED_DURABILITY, not quiet local
  authority a redeploy would erase. When local mode is intentionally on,
  status says so unmistakably: durabilityMode = LOCAL_NON_DURABLE,
  authoritativeJournal = LOCAL_FILE, durableAcrossRedeploy = false. In
  durable mode the local file is only the best-effort mirror
  (durabilityMode = DURABLE_CORE, authoritativeJournal = INJECTED) — never
  the authority.

- HISTORY-LEVEL CONSISTENCY. Individually-valid but mutually-impossible
  histories fail replay: one source root cannot both settle a claim and
  withhold coin resolution; one proposition gets exactly one terminal
  outcome (packet XOR withheld) in either order, and never two packets;
  lifecycle events (PROVIDER_FAILURE, STARTED) are truth-inert wherever
  they appear and reset nothing. Event-journal injection can never bypass
  the transaction-level exclusivity laws.

- NO NEW DURABLE VERSION. This pass adds writer fencing, the explicit
  local-mode gate, and the coverage-semantics seal without changing the
  durable packet, event, checkpoint, or schema structure — so checkpoint
  version 4 and schema version 6 stand unchanged.
