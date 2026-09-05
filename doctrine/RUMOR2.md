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

## What RUMOR-2A is not

No X. No Reddit. No Reuters/Bloomberg/CNBC/FT/CoinDesk/any publisher. No
item-link crawling. No Socrates call, no model, no prompt, no key. No
GHOST. Zero Attention weight, zero HYPED authority, zero stalking, zero
eligibility, zero Brain, zero STRIKE, zero execution. Those boundaries
are enforced by tests, not comments.
