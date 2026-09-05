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
- **Point-in-time** — `socialClocks` / normalization enforce created ≤ retrieved =
  knownAt and reject future source clocks.
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

## 5. Durability (frozen event root, writer epoch)

`rumor2/social-settle.js` maps a normalized social observation into the frozen
`RUMOR2_SOURCE_OBSERVED` event (evidence-only, like EDGAR/OFAC), settling through
the **same** PostgreSQL journal under the **same** advisory-lock writer + database
writer epoch. `test/social-durable.test.js` proves against real PostgreSQL that a
social event appends only under a held writer epoch, is refused without one, and
collapses an exact re-append (crash-safe restart) — with **no new migration**
(schema 7 stands), **no parallel table**, and **no social-specific checkpoint**.

**Checkpoint/version decision:** SOCIAL-1 makes **no** checkpoint-version change.
Social evidence rides the existing event schema; the durable proof is at the
journal + writer-epoch layer. Registering the active social provider into the
checkpoint provider set (an explicit v4→v5 migration) and auto-draining the ear
inside the single-writer collector are the **remaining SOCIAL-1→SOCIAL-2 boundary**
(see below) — deliberately deferred so the frozen claim-graph collector, checkpoint,
and event validators are **not** modified in this ticket (zero-regression: SOCIAL-1
adds only new files).

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
