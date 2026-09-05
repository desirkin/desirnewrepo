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

Roadmap unchanged: RUMOR-2B may later add authorized social ears and
propagation reasoning; SOCRATES remains separate; GHOST remains separate;
derivatives and on-chain senses remain separate. None of those exist yet.

## What RUMOR-2A is not

No X. No Reddit. No Reuters/Bloomberg/CNBC/FT/CoinDesk/any publisher. No
item-link crawling. No Socrates call, no model, no prompt, no key. No
GHOST. Zero Attention weight, zero HYPED authority, zero stalking, zero
eligibility, zero Brain, zero STRIKE, zero execution. Those boundaries
are enforced by tests, not comments.
