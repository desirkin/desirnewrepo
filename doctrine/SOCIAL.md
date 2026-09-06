# SOCIAL RUMOR INTELLIGENCE — SOCIAL-1 FOUNDATION

This is **SOCIAL-1**, the first ticket after the frozen RUMOR-2 core. It establishes
the shared social truth contract, the current access census, the first live ear
(Bluesky) and the Farcaster adapter, and the pump/propagation foundation. Social
is **DARK / SOURCE-ONLY** and has **no trade authority**. This layer is **NOT
frozen** — it is the foundation the later social sub-tickets build on.

Everything here plugs into the frozen RUMOR-2 event root; it does **not** create a
parallel rumor engine, a parallel truth table, or a social-specific checkpoint.

---

## 1. Doctrine (the deliberate laws)

- **Source-only, dark.** A social post is EVIDENCE. It never becomes a claim,
  never corroborates an official claim automatically, and has no path to
  Attention / HYPED / eligibility / score / sizing / paper or live execution.
  Social providerKinds (`SOCIAL_MICROBLOG`, `SOCIAL_FORUM`, `SOCIAL_FINANCE`) are
  not in the frozen claim-capable set, so the deterministic classifier returns
  `null` for them — no typed claim can ever originate from a social ear.
- **Pumps are information, not a veto.** Serpent does **not** auto-reject pumps.
  Early coordinated ignition may be the most tradable event; late coordinated
  distribution may be dangerous. The layer records stage/coordination FEATURES
  and provenance; it never converts `COORDINATED` into `REJECT` and makes no
  trade decision. The concept: *detect early, take the tradable slice, do not
  become exit liquidity* — a decision made later by Socrates/Arbiter, never here.
- **Volume ≠ independence.** 10,000 reposts are one information family, not
  10,000 confirmations. Engagement (likes/reposts/upvotes/views) is attention
  metadata, never factual confirmation.
- **Point-in-time.** `sourceCreatedTs` (posted) ≤ `retrievedTs` (fetched) ≤
  `knownAtTs` (when Serpent actually knew). `knownAt` is never backdated to the
  post's creation; replay preserves the old creation clock and uses the replay
  acquisition time as knowledge time. A future source clock fails closed.
- **Identity is provider-native and immutable.** A post is `(provider,
  nativePostId)`; an author is `(provider, nativeAuthorId)`. Handles/usernames
  change and are never the durable identity. Identities are never merged across
  networks (cross-platform linkage is later, evidence-gated work).
- **No unauthorized access.** No scraping around access controls, no private
  accounts, no stolen cookies, no user-session emulation, no unofficial scraping
  services as authoritative truth. An unavailable ear reports a truthful access
  state and reason — never a scrape fallback.
- **No LLM.** SOCIAL-1 proves deterministic truth/provenance primitives only.

---

## 2. Access census (verified against current official docs, 2026-09-05)

The machine-readable census lives in `rumor2/social-registry.js` and is pinned by
`test/social-census.test.js`. States use the closed taxonomy in `SOCIAL_ACCESS_STATES`.

| Provider | Kind | Access state | Why (summary) |
|---|---|---|---|
| **BLUESKY_OFFICIAL** | microblog | `AVAILABLE_AUTHORIZED` | Free, public, unauthenticated Jetstream v2 real-time firehose with collection/DID filtering + replay. The first live ear. |
| **FARCASTER_OFFICIAL** | microblog | `AVAILABLE_REQUIRES_CREDENTIAL` | Neynar hosted API (x-api-key, free tier) gives real-time webhooks + cast search. Hub/Snapchain path needs a full syncing node (not lightweight). Dark until `NEYNAR_API_KEY`. |
| **X_OFFICIAL** | microblog | `AVAILABLE_REQUIRES_CREDENTIAL` | Pay-per-use filtered stream (~4–5s P99), OAuth2 App-Only bearer. Needs a hard read budget under the 3M-post-read/month self-serve cap ($0.005/read; usage via `/2/usage/tweets`; 24h dedup). Operational collector = SOCIAL-2. |
| **REDDIT_OFFICIAL** | forum | `AVAILABLE_RESTRICTED_RESEARCH` | Official Data API (OAuth2, 100 QPM/client) is usable, but **commercial** use requires a written contract; scraping is prohibited. Contract-gated for this system. |
| **STOCKTWITS_OFFICIAL** | finance | `NOT_ACCEPTING_NEW_ACCESS` | Self-serve dev program paused ("won't be accepting new registrations"); public API docs offline (404). Firestream enterprise firehose is partner-gated with no self-serve terms. **High priority, blocked by access — not by importance.** |
| **META_PUBLIC** (FB Page) | microblog | `AVAILABLE_REQUIRES_APP_REVIEW` | Page Public Content Access reads public Page posts but requires Meta App Review + Business Verification. |
| **TIKTOK_PUBLIC** | microblog | `NOT_AUTHORIZED` | Only organic-content API (Research API) bars commercial use + is archival/day-granular with no streaming; Commercial Content API is ads/EU only; Display API is own-content only. **Final decision: `EXCLUDED_FROM_REALTIME_RUMOR`** — not a TODO. |

Sub-decisions recorded but not built as separate providers:
- **Instagram (Graph API)** → `NOT_SUITABLE_REALTIME`: no public firehose, only capped
  hashtag search on business tokens.
- **Meta Content Library** → `AVAILABLE_RESTRICTED_RESEARCH`: near-real-time FB/IG/Threads/
  WhatsApp-Channel public content, but academic/non-profit research only (CASD-vetted, secure
  enclave, export blocked) — a commercial trading-research system is ineligible.

Official sources: bsky.network/docs/jetstream · docs.neynar.com · dev.neynar.com/pricing ·
docs.farcaster.xyz · docs.x.com/x-api · support.reddithelp.com (Data API / Public Content Policy) ·
api.stocktwits.com/developers · firestream-portal.stocktwits.com · developers.facebook.com
(page-public-content-access, content-library-and-api) · developers.tiktok.com (research-api,
commercial-content-api, display-api).

---

## 3. Shared social contract (`rumor2/social.js`)

One bounded, closed normalized observation shape all adapters converge on — no raw
API blobs, no unbounded fields. Key pieces:
- **Identity** — `socialSourceIdentity({provider,nativePostId})` (`r2ss-…`) and
  `socialAuthorIdentity({provider,nativeAuthorId})` (`r2sa-…`). Content is **not**
  part of post identity, so an altered re-delivery of the same native id is caught
  as corruption at the ear, never accepted as a new post.
- **Point-in-time** — normalization enforces `sourceCreatedTs ≤ retrieved = knownAt`
  when the source clock is **known**, or only `retrieved = knownAt` when it is
  UNKNOWN (`null`); a known future source clock is rejected. `sourceCreatedTs` is
  provider-supplied or `null`/UNKNOWN — never fabricated from the local wall clock.
- **Relationships** — `SOCIAL_RELATION_KINDS` (ORIGINAL/REPLY/REPOST/QUOTE/
  CROSSPOST/POSSIBLE_COPY/UNKNOWN); `ECHO_RELATIONS` (REPOST/QUOTE/CROSSPOST) can
  never be independent provenance.
- **Deterministic near-duplicate (non-LLM)** — conservative normalization
  (NFKC/lowercase/zero-width strip/URL-tracking strip/whitespace + runaway-punct
  collapse), token shingles, Jaccard similarity → a candidate echo signal, never
  final identity.
- **Propagation vs independence** — `propagationVsIndependence` separates raw
  propagation from independent provenance families; explicit echoes and
  near-duplicates collapse into their origin family; genuinely different accounts
  stay distinct (independence reasoning is SOCIAL-5).
- **Pump/coordination features** — `coordinationFeatures` computes velocity,
  unique-author velocity, repost ratio, near-duplicate ratio, independent-origin
  ratio, burst concentration, originator concentration, and (only when metadata is
  present) new-account / verified ratios. Unknown metadata is `null`, never guessed.
  No decision/reject/trade field exists.
- **Stage (research label, DARK)** — `SOCIAL_STAGE_STATES` + `estimateSocialStage`
  return `UNKNOWN`/`calibrated:false`. Thresholds are deliberately uncalibrated
  (deferred to SOCIAL-5); a stage is never a trade verb.
- **Author record** — `emptyAuthorRecord` holds objective histories only (no
  good/bad score, no social-credit).
- **Universe filter** — `buildSocialFilter` / `socialFilterMatches` give a bounded,
  deterministic, observable filter; an empty filter matches nothing (no silent
  all-network intake).

---

## 4. The ears

- **Bluesky (live, first ear).** `rumor2/providers/bluesky-official.js` maps
  Jetstream v2 commit messages (post/repost/reply/quote/delete) to the shared
  contract; `rumor2/social-stream.js` is the bounded transport: exact host
  allowlist, one connection, bounded reconnect with exponential backoff,
  heartbeat/stall detection, max message size, closed JSON parse, bounded
  backpressured queue, clean shutdown, LIVE + fixture REPLAY modes. Injected
  socket + timers keep tests network-free.
- **Farcaster (adapter, dark).** `rumor2/providers/farcaster-official.js` maps
  Neynar webhook events (cast.created / cast.deleted / reaction recast) to the
  shared contract, keyed on cast hash + FID (never the mutable fname). The live
  transport is gated on `NEYNAR_API_KEY` and stays dark without it.

---

## 5. Durability (frozen event root, writer epoch) — SOCIAL-1 closeout

`rumor2/social-settle.js` maps a normalized social observation into a **closed,
versioned `RUMOR2_SOCIAL_OBSERVED` event** that settles through the **same**
PostgreSQL RUMOR journal, under the **same** advisory-lock writer + database
writer epoch (no parallel engine, no parallel table, no social checkpoint). A
dedicated social event — rather than the generic `RUMOR2_SOURCE_OBSERVED` —
preserves the provenance SOCIAL-5 will need (author identity, repost/reply/quote
relationship, thread identity, native version/CID, lifecycle) that the generic
11-key source event would silently drop. It lives entirely in the social layer
with its own closed validator (`validateSocialEvent`) and replay witness
(`reconstructSocialWitness`); the frozen `truth.js` validators are **untouched**,
so all frozen non-social semantics and tests are unchanged.

Durable facts preserved: `socialSourceId` (stable post identity), `provider`,
`providerKind`, `nativePostId`, `nativeAuthorId`, `socialAuthorId`, `lifecycle`
(CREATE/EDIT/DELETE/TOMBSTONE), `relation`, `parentNativePostId`, `threadId`,
`nativeVersionId` (CID where the provider supplies one), `text`, `textHash`,
`sourceCreatedTs` (or `null`/UNKNOWN), the retrieved/known point-in-time clocks,
and — as Serpent's **first-known DIAGNOSTIC snapshot** — `handle`, closed
`authorMeta`, `engagement`, bound by `metaHash`. Every identity is **re-derived**
on validation — a forged id cannot authenticate altered facts.

**Content identity vs first-known metadata — two hashes (§26).** The seal draws
one hard line between what a post *is* and what Serpent *first observed about it*:

- **CONTENT / VERSION HASH.** `socialSourceId` is the stable post identity
  (`provider`+`nativePostId`); the event's `sourceEventId` is a distinct **version
  identity** binding ONLY the immutable provider content/provenance/lifecycle
  facts — lifecycle, relation, parent, thread, native version id (CID) where
  supplied, `textHash`, and the source-creation time (canonicalized `null` when
  UNKNOWN) — via one canonical `socialProvenanceFacts` recipe shared by mapper,
  settle, and validator. It never binds handle, follower count, verification, or
  engagement, so a handle rename / follower change / engagement growth on an
  unchanged post can **never** manufacture a fake new content version.
- **DIAGNOSTIC / META HASH.** `metaHash` binds Serpent's first-known MUTABLE
  diagnostic snapshot for that historical event: `handle`, `authorMeta`, and the
  first-known `engagement` (via `socialDiagnosticFacts`). It gives the diagnostics
  integrity — once stored they cannot be silently rewritten — without making them
  part of content identity.

Validation re-derives **BOTH**, so no stored fact can be altered under the same
event identity: a content change yields a legitimately re-derived new version (or,
at a KEPT native version id, is rejected as corruption); a stored-diagnostic
rewrite is rejected by `metaHash`. **First-known duplicate law (§6):** a later
redelivery of the *same* immutable version whose handle / followers / engagement
have changed is neither a new version nor corruption — the pipeline dedupes it by
version identity **keep-first** (at the intake ear, exactly as engagement always
was), so only the FIRST diagnostic snapshot is ever settled; the durable journal
never receives a conflicting payload under one `sourceEventId`. Future author/
metric time-series is a SOCIAL-2+ concern (explicitly versioned metric events),
not built here.

**Author metadata (§14–§21).** `authorMeta` is a CLOSED bounded 5-key shape —
`accountCreatedTs`, `followerCount`, `followingCount`, `verified`, `powerBadge` —
with `null`/UNKNOWN wherever a provider does not supply a value (no fake zero, no
default false, no unbounded blob). It is **information only** (new-account /
follower-distribution / coordination research for SOCIAL-5/6); it is **never**
author identity (`socialAuthorId` stays `provider`+`nativeAuthorId`) and carries
**zero** claim/trade authority. It survives the journal and `reconstructSocialWitness`
exactly, so later stages need not reconstruct facts SOCIAL-1 already knew.

**Point-in-time clock law (§7–§13).** `sourceCreatedTs` is the provider-supplied
source-creation time **OR** `null`/UNKNOWN — Serpent **never** fabricates it from
its own processing clock (`Date.now()`), from `retrievedTs`, or from a lifecycle
event's commit time. A DELETE/TOMBSTONE's commit time is *not* the original post's
creation, so a delete carries `sourceCreatedTs = null`. When the source time is
known, validation enforces `sourceCreatedTs ≤ retrievedTs ≤ knownAtTs` (a future
source clock fails closed); when unknown, only `retrievedTs ≤ knownAtTs`, with
`sourceCreatedTs` canonicalized to a stable `null` so the version identity stays
deterministic across redelivery/replay. `knownAt` is never backdated to creation.

Trust boundary (§28): Serpent does not retain enough AT-record bytes to recompute
a Bluesky CID, so the CID is native version *evidence* while Serpent's own event
identity provides the immutable journal binding — no field is trusted merely
because a valid CID accompanies it. Deletions never fabricate a missing
parent/target (relation `UNKNOWN`, parent `null`); the stable `socialSourceId`
ties a DELETE back to its earlier CREATE. `validateSocialEvent` is closed by
default against the authoritative social registry — an optional caller allowlist
can only narrow it, never authorize an unregistered provider.

`test/social-durable.test.js` (real PostgreSQL) proves: round-trip with all facts
intact + identities re-derived; the writer-epoch fence applies (no epoch → refused);
duplicate delivery collapses to one truth; repost/edit/delete survive restart; a
Farcaster cast round-trips (hash/FID/recast); forgery/undeclared fields reject;
and point-in-time is preserved. **No new migration** (schema 7 stands); **no**
checkpoint-version change.

**Checkpoint/version decision:** SOCIAL-1 makes **no** checkpoint-version change
and does **not** register social providers into the checkpoint provider set. The
durable social event and its validator are the READY contract; **auto-draining**
the Bluesky ear inside the single-writer collector (operational activation) is the
**SOCIAL-2 boundary** — deferred so the frozen collector/checkpoint/claim-graph are
not modified here. When auto-drain activates, the collector's replay must learn to
carry `RUMOR2_SOCIAL_OBSERVED` events (source-only, no graph/claim effect).

---

## 6. Authority audit

- Social providerKinds are not claim-capable → `classifyOfficialItem` returns
  `null` → no typed claim, ever.
- The stage estimate is `UNKNOWN`/uncalibrated and never a trade verb.
- No social path to Attention/HYPED/eligibility/score/sizing/execution.

---

## 7. Remaining work before SOCIAL RUMOR can be frozen

SOCIAL-1 is the foundation; it is **not** the frozen social layer. Remaining:

- **SOCIAL-1 completion (into SOCIAL-2):** register the active social provider in
  the checkpoint provider set via an explicit checkpoint v4→v5 migration, and
  auto-drain the Bluesky ear inside the single-writer collector tick so social
  evidence settles operationally (not just via the proven journal bridge). Add a
  bounded live Bluesky smoke test.
- **SOCIAL-2:** X / Twitter operational collector (filtered-stream + hard cost gate
  against the 3M/month cap and `/2/usage/tweets`).
- **SOCIAL-3:** Reddit operational collector (only under a commercial agreement).
- **SOCIAL-4:** StockTwits operational collector **iff** legitimate API access
  becomes available (Firestream), else a formal exclusion/access decision.
- **SOCIAL-5:** cross-platform provenance / propagation / pump-stage engine
  (calibrate the stage classifier against real history).
- **SOCIAL-6:** author reliability / deletion / historical-outcome research.
- **SOCIAL-7:** full combined social hardening + freeze.

Do not call the social layer complete until every intended provider is either
operational-and-tested or explicitly excluded with a current reason, and the
cross-platform provenance/reputation logic exists.
