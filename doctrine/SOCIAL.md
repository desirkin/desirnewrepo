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
  acquisition time as knowledge time. A future source-declared clock is
  QUARANTINED from causal use (§5B) — the evidence is kept, knownAt never moves.
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
| **FARCASTER_OFFICIAL** | microblog | `AVAILABLE_REQUIRES_CREDENTIAL` | Neynar hosted API (x-api-key) documents event webhooks, cast search, a Kafka stream, and gRPC hub access; Neynar **publishes** a Free plan with per-endpoint limits (docs, 2026-09-06). THIS project's plan, credits, entitlement, terms (retrieval failed 2026-09-06), retention, and cost are **UNKNOWN/UNVERIFIED**. Mapper present; **no live transport or collector wiring**; a configured `NEYNAR_API_KEY` is configuration only. Hub/Snapchain needs a full node. Acquisition path is a proposal pending terms/plan/recovery/scope (§5H). SOCIAL-4E: pure access/readiness boundary (`rumor2/social-farcaster-access.js`, §5P) — not operational access. |
| **X_OFFICIAL** | microblog | `AVAILABLE_REQUIRES_CREDENTIAL` | Pay-per-use filtered stream (~4–5s P99), OAuth2 App-Only bearer. Hard read/USD budget under the 3M-post-read/month self-serve cap ($0.005/read; usage via `/2/usage/tweets`; UTC-day dedupe is SOFT). Operational, runtime-gated ear since SOCIAL-2B (§5C). |
| **REDDIT_OFFICIAL** | forum | `AVAILABLE_REQUIRES_APPROVAL_AND_CLASSIFICATION` | Official OAuth2 Data API is a documented path; API data access requires Reddit's explicit approval with honest disclosure. Serpent's private single-user personal-trading use is **UNRESOLVED** (not assumed commercial, not assumed exempt); any separate-agreement requirement and retention compatibility are unresolved. Scraping is prohibited. Fixture-only foundation (SOCIAL-3, §5F) — not an operational ear. |
| **STOCKTWITS_OFFICIAL** | finance | `AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW` | ONE platform, several routes (SOCIAL-4B, §5G). Self-service registration is **paused** (route-specific). Firestream message/activity/reference/backup routes are documented for stream-authorized accounts (HTTP Basic); general Terms (revised 2026-07-10) permit only authorized API/developer access and let offering terms prevail. This account's entitlement, Serpent's permitted use, additional terms, and raw-content/author retention are **UNRESOLVED**. A **legacy aggregate RUMINT ear exists separately** (config-enabled; deployment unobserved; entitlement unresolved). New raw Social path: fixture-only, retention-blocked. **High priority, blocked by entitlement/terms review — not by importance.** |
| **META_PUBLIC** (Facebook + Instagram routes) | microblog | `AVAILABLE_REQUIRES_APP_REVIEW` | Route-specific (SOCIAL-4D, docs 2026-09-06): Page Public Content Access (public posts/comments of unmanaged Pages; App Review + Business Verification); Page Public Metadata Access (metadata only); managed Pages (own Pages only); Instagram Login (own professional account); Instagram with Facebook Login (capped hashtag search 30/7 days + business discovery; professional account + Page + App Review; no realtime delivery documented); Content Library (research archive; academic/not-for-profit affiliation reviewed by a partner — **not established for this project**); Ad Library (ads only); Groups API removed 2024-04-22. No firehose; latency unmeasured; eligibility for this project **NOT ESTABLISHED**; no application made or denied; retention/inference need route-specific review. SOCIAL-4E: ten route descriptors in FACEBOOK / INSTAGRAM namespaces, route-bound readiness, fixture-only previews (`rumor2/social-meta.js`, §5P) — not operational access. |
| **TIKTOK_PUBLIC** | microblog | `NOT_AUTHORIZED` (no authorized route established on the supplied facts) | Product-by-product (SOCIAL-4D, docs 2026-09-06): Research Tools require an eligible academic/not-for-profit affiliation, non-commercial public-interest research, ethics review, and project approval — **not established for this project**; on THAT route new videos take up to 48 h to enter search and some metrics up to 10 days (route-specific, not every product). Display API reads only the authorizing user's own videos. Commercial Content API is an ads/commercial dataset (EU data in this phase, open application) — a dataset name, not a classification of Serpent's use. **Current decision:** `INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED`, `OPERATOR_REVIEW_PENDING` — no application, no denial, no permanent exclusion approved. SOCIAL-4E: three product descriptors, product-bound readiness, fixture-only Research/Display video preview (`rumor2/social-tiktok.js`, §5P) — decision unchanged; not operational access. |

**Scope note (SOCIAL-4F, §5Q):** the census above is the PROVIDER census. The ASSET scope of Social
research is the DISCOVERY_CATALOG (the wide eye's accepted Kraken USD spot metadata), not
`config.universe`; the five legacy config assets remain the LEGACY_PERMISSION_SET for cost/ledger/
official-claim purposes only.

Sub-decisions recorded but not built as separate providers (SOCIAL-4D wording; no route enabled):
- **Instagram** is reviewed separately from Facebook: Instagram Login reads only the authorizing
  professional account; Instagram with Facebook Login adds hashtag search (30 unique hashtags per
  7 days) and business discovery for an eligible business app; no realtime delivery is documented.
  A bounded authorized read is not broad minutes-scale discovery, and no firehose does not by
  itself prove zero research value — utility is an unmeasured hypothesis. No professional
  account, Page linkage, app, or review exists for this project.
- **Meta Content Library / API** → `AVAILABLE_RESTRICTED_RESEARCH`: FB/IG/Threads public content
  in a controlled research environment; eligibility is an academic or not-for-profit affiliation
  reviewed by a partner (CASD/ICPSR), with export restricted. That affiliation is **not
  established for this project**; Serpent is not thereby classified as commercial. Retention,
  deletion, and inference permissions require their own route-specific review (Reddit's terms are
  never imported into Meta).

Official sources: bsky.network/docs/jetstream · docs.neynar.com · dev.neynar.com/pricing ·
docs.farcaster.xyz · docs.x.com/x-api · support.reddithelp.com (Data API / Public Content Policy) ·
api.stocktwits.com/developers · firestream-portal.stocktwits.com · stocktwits.com/about/legal (terms,
privacy) · developers.facebook.com
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
  when the source clock is TRUSTED, or only `retrieved = knownAt` when it is
  UNKNOWN or FUTURE_QUARANTINED (`sourceCreatedTs = null`, declared value kept —
  §5B). `sourceDeclaredTs` is provider-supplied or `null`/UNKNOWN — never
  fabricated from the local wall clock.
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
  contract. **Live wire (SOCIAL-2A protocol seal):** the subscription is the
  current v2 XRPC contract — `/xrpc/network.bsky.jetstream.subscribeEvents`,
  subprotocol `xrpc.v1.json`, query `kinds=commit&collections=app.bsky.feed.post&
  collections=app.bsky.feed.repost[&cursor=<durable seq>]` (deterministic order;
  commit events only, post/repost only). Legacy v1 names (`wantedCollections`,
  `wantedDids`, `requireHello`, `options_update`) are rejected by v2 and are never
  sent. Jetstream `seq` is the monotonic per-event sequence / resume cursor
  (inclusive, at-least-once); the server `time` field is a separate clock; neither
  is the post's `record.createdAt` (`sourceCreatedTs`). A connect that fails while
  presenting a resume cursor (e.g. v2 `CursorTooOld`, an HTTP 400 handshake) is
  surfaced in stream status (`cursorResumeFailures`, `lastConnectCursor`,
  `lastCloseCode/Reason`) and the same durable cursor is re-presented — never a
  live-tail fallback, never a skipped gap (the global WebSocket API exposes no HTTP
  400 body, so the XRPC error name itself is not readable; archive backfill is
  future work); `rumor2/social-stream.js` is the bounded transport: exact host
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
the Bluesky ear inside the single-writer collector (operational activation) was the
**SOCIAL-2 boundary** — landed in SOCIAL-2A (§5A): the collector carries
`RUMOR2_SOCIAL_OBSERVED` / `RUMOR2_SOCIAL_CURSOR` through a separate Social replay path
(source-only, no graph/claim effect), still with no checkpoint-version change.

---

## 5A. SOCIAL-2A — Bluesky operational activation under the durable Social resume law

The Bluesky ear runs **inside** the single-writer RUMOR collector (`rumor2/collector.js`
→ `rumor2/social-runtime.js`), behind the explicit gate `RUMOR2_SOCIAL_BLUESKY_ENABLED=true`
(default **false**; enabling Bluesky enables only Bluesky; `RUMOR2_SOCIAL_MODE=REPLAY`
keeps fixture replay). ONE writer, ONE epoch, ONE PostgreSQL event root — no social
database, journal, writer, epoch, or checkpoint authority exists (§36).

**Core law (§3):** `RECEIVED ≠ NORMALIZED ≠ QUEUED ≠ DURABLE`, and
`CURSOR RECEIVED ≠ CURSOR SAFE TO RESUME FROM`. Only a journal batch settled under the
**current** writer epoch advances Serpent's durable Social position.

- **Durable keep-first (§4–§8).** The frozen journal's duplicate law is untouched
  (byte-identical ⇒ collapse; same identity + altered payload ⇒ corruption). The Social
  layer guarantees a diagnostic-only redelivery of an already-settled content version
  never reaches the journal: `replaySocialHistory` rebuilds a **durable version index**
  (every settled `RUMOR2_SOCIAL_OBSERVED` `sourceEventId`) on every hydrate and the
  runtime maintains it after every append; the intake consults it before the local LRU;
  and before any append the runtime asks the narrow **read-only** journal lookup
  (`hasEventIds` → `Repository.hasRumor2EventIds`, a pure SELECT) for any id outside the
  index. Proven across a real process restart and across LRU eviction: first durable
  truth stands.
- **Provider lifecycle identity (§9–§13).** Jetstream `seq` is preserved as
  `providerEventSeq` — closed, bounded, provider-supplied, replay-stable, never
  wall-clock — and is a CONTENT/VERSION fact, so CREATE/DELETE/RECREATE/DELETE on one
  `at://` key are four versions and two *distinct* deletes never collapse into one
  tombstone, while the same commit redelivered 100× is one truth. `socialSourceId` never
  carries it; `sourceCreatedTs` never comes from it. Non-Bluesky providers must carry
  `null`; a caller-supplied seq cannot authenticate a foreign event.
- **Two cursors (§14/§18).** `receivedCursor` is diagnostic. The intake keeps a
  **contiguous** cursor: the highest seq such that every delivered frame at/below it has
  an intentional terminal disposition (filtered/skipped/rejected/deduped/durably settled).
  An enqueued frame pins it until settled; a queue-full DROP pins it until Jetstream
  replays the frame. It is monotonic (§24).
- **Durable cursor = a journal event (§15/§16).** Each settle builds
  `[evidence…, RUMOR2_SOCIAL_CURSOR]` — the cursor event **last**, from the same batch,
  with a deterministic `r2sc-` identity per `(provider, cursor)` — and appends it as one
  epoch-fenced atomic batch; only after the commit does the runtime adopt the index and
  `durableCursor`. A failed append retains the batch whole (retry is byte-identical);
  there is no API to persist a cursor without its evidence, so the cursor cannot outrun
  the journal. No checkpoint version change was needed (the checkpoint's
  `lastSettledEventSeq` watermark simply advances over Social batches).
- **Backpressure (§19).** Queue full ⇒ the stream **pauses** (socket closed), earlier
  queued work settles, and the reconnect resumes from the **durable** cursor so Jetstream
  replays the dropped frames. Latency may be sacrificed; truth may not.
- **Single-writer ownership (§21).** The ear becomes ACTIVE only after the collector
  positively holds writer authority; every standby transition (lost fence, stale epoch,
  failed durability, shutdown) stops the stream immediately and discards nothing durable;
  reacquisition re-hydrates from the journal and reconnects from the durable cursor.
- **Social replay (§22/§23).** The frozen `replayRumor2SettledTruth` sees only core
  event kinds (the collector filters Social kinds before it and skips them in the
  watermark tail reconciliation); `replaySocialHistory` validates every Social event
  (`validateSocialEvent` / `validateSocialCursorEvent`), enforces the duplicate law inside
  Social history, and refuses cursor regression — a corrupt Social history withholds the
  collector fail-closed. Social events feed no graph/claim/packet/Attention/HYPED state.

Crash matrix (`test/social-runtime.test.js`, real PostgreSQL): crash before normalize,
before append, evidence-without-cursor (torn), atomic-then-crash, cursor-before-evidence
(impossible by construction), writer loss before/after append, and diagnostic-changed
redelivery after restart — all replay safely with evidence exactly once.

---

## 5B. SOURCE-CLOCK QUARANTINE SEAL — three clocks, no discarded evidence

The first real Bluesky live smoke showed ~6% of posts carrying a client-supplied
`record.createdAt` ahead of Serpent's wall clock (28 ms – 87 s); the old law dropped
them. A bad client clock must never discard valid social evidence — and must never
make Serpent believe it knew something earlier than it did. Serpent now keeps three
explicitly distinct clocks on every social observation/event:

| Clock | Field | Meaning |
|---|---|---|
| A. source-declared | `sourceDeclaredTs` | the provider-record creation time (Bluesky `record.createdAt`, Farcaster cast timestamp) as an integer-millisecond PROJECTION of the declaration: client-supplied, immutable record content, **not** an authoritative clock. SOCIAL-4D COMPLETION (§5I): every adapter derives it from a bounded temporal witness under the field's documented grammar (never `Date.parse`, never the host zone); the witness retains the declaration and its exact sub-millisecond remainder, and the verdict may be `ORDER_UNRESOLVED` |
| B. provider event | `providerEventTs` | the transport/provider event clock (Jetstream `payload.time`), RFC3339-parsed or `null`; never original creation, never knowledge time |
| C. Serpent knowledge | `retrievedTs` / `knownAtTs` | the ONLY causal truth; **never backdated** by any source or provider clock |

`sourceCreatedTs` is the **trusted** source clock: equal to `sourceDeclaredTs` when
`sourceDeclaredTs ≤ retrievedTs`, else `null`. The closed verdict `sourceClockStatus`
∈ {`TRUSTED`, `FUTURE_QUARANTINED`, `UNKNOWN`} says why: TRUSTED (declared ≤ retrieved),
FUTURE_QUARANTINED (declared > retrieved — the declared value is preserved as
evidence, `sourceCreatedTs = null`, and `sourceClockSkewMs = sourceDeclaredTs −
retrievedTs`, ONE definition, clamped to ±10 years as a safe integer), UNKNOWN (no
valid declared clock; a malformed provider timestamp maps to `null` at the adapter —
the evidence is kept, never `Date.now()`). Deletes: `sourceDeclaredTs = null`, UNKNOWN,
but `providerEventTs`/`providerEventSeq` preserved. Forbidden: clamping the source
clock to retrieval, pretending creation = retrieval, backdating knownAt, rewriting the
provider's value, or trusting a future clock for ordering/lead-time/anything.

Identity: `sourceDeclaredTs` is immutable record content and is bound into the
CONTENT/VERSION identity (a different declared clock on the same CID is a different
immutable record). The acquisition-dependent verdict/skew and `providerEventTs` are
FIRST-KNOWN diagnostics bound by `metaHash`: a later redelivery after wall time
caught up dedupes keep-first and can never rewrite the first-known quarantine. The
validator re-derives the verdict from the stored declared clock and `retrievedTs`, so
a forged TRUSTED, a fabricated `sourceCreatedTs`, or a rewritten skew is rejected.

Contract for later layers (SOCIAL-5+): primary causal ordering = `knownAtTs`;
provider-native ordering = `providerEventSeq`; provider timing = `providerEventTs`;
`sourceCreatedTs` only when `TRUSTED`; a quarantined `sourceDeclaredTs` is descriptive
only. No clock anomaly rejects an asset, a pump, an author, or a trade — that is
future research, not a rule. Operational counters (`sourceClockTrusted` /
`sourceClockFutureQuarantined` / `sourceClockUnknown`) are observability only.

---

## 5C. SOCIAL-2B — X/Twitter operational ear + hard cost governor + first-known acquisition clocks

**Job A — first-known acquisition clock law.** `retrievedTs`/`knownAtTs` are Serpent's
first-known acquisition truth: NOT provider content identity (a later redelivery of the
same immutable version derives the SAME `socialVersionId` and is absorbed keep-first),
but bound by the diagnostic `metaHash` once durable — a stored event's acquisition clock
can never be silently rewritten (PIT-1..5, `test/social-acquisition-clock.test.js`). No
source/provider clock can grant earlier knowledge.

**Current official X contract (pinned 2026-09-06, docs.x.com).** Filtered Stream
`GET /2/tweets/search/stream`; rules `GET/POST /2/tweets/search/stream/rules`
(`dry_run=true`), `GET …/rules/counts`; usage `GET /2/usage/tweets`, `GET /2/usage/credits`;
OAuth2 App-Only Bearer; Pay-per-use: 1 connection/project, 1,000 rules/project, 1,024
chars/rule; ~4–5 s P99; blank CRLF keepalive ~20 s (no data/keepalive for 20 s ⇒ reconnect);
`backfill_minutes` 0..5; Post read $0.005, User read $0.010, 3,000,000 Post reads per
monthly cycle; UTC-day billing dedupe is **SOFT** — never a safety barrier.

**Three boundaries (§6).** X server-side rules (first cost/noise boundary) → bounded X HTTP
transport → normalized observation → Serpent universe filter (second) → durable source-only
RUMOR evidence → RUMOR analysis (third). Serpent never subscribes to the whole firehose.

**Registry semantics (§7).** `X_OFFICIAL` stays `AVAILABLE_REQUIRES_CREDENTIAL` (platform
capability), `implemented`/`durable` (implementation capability), `runtimeGated` (runtime
authorization = enable gate + bearer + hard budget + usage preflight + reconciled rules +
collector writer fence). A static flag never implies a credential. X is not in the frozen
frozen core's five official providers (EDGAR and OFAC among them are source-only, not claim-capable); it is classifier-null.

**Gates — default cost zero (§8).** `RUMOR2_SOCIAL_X_ENABLED` (false), `X_BEARER_TOKEN`,
`RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS`, `RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS` (≤ 3M),
`RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD`; optional `…_MAX_SESSION_POST_READS`,
`…_LIVE_SMOKE_TARGET_POST_READS` + `…_LIVE_SMOKE_MAX_POST_READS` + `…_LIVE_SMOKE_RUN_ID` (a
triple — see §5D/§5E),
`…_PRIORITY_ACCOUNTS`, `…_PROPAGATION_FOCUS`. Missing bearer ⇒
CREDENTIAL_MISSING; missing/zero/negative/absurd budget ⇒ BUDGET_NOT_CONFIGURED / BUDGET_INVALID.
No default paid budget exists; `RUMOR2_SOCIAL_X_ENABLED=true` alone spends nothing.

**Cost governor (§9–§15).** Every delivered Post resource is metered at the wire BEFORE
universe/duplicate/durable filtering (keepalives cost nothing; backfill/duplicates are
counted every time). The durable `RUMOR2_SOCIAL_X_METER` (UTC day + month cumulative reads,
estimated USD at the pinned price, latest closed server-usage snapshot) is appended in the
same batch as evidence, so a restart never resets spend. Before every paid connection the
strictest allowance is computed from the daily/monthly/USD caps, the fresh `/2/usage/tweets`
snapshot (higher of server/local; stale > 6 h ⇒ refuse), `/2/usage/credits` when the
credential supports it (else honestly `UNAVAILABLE_FOR_CREDENTIAL`), the session/smoke caps,
minus the pinned headroom `X_IN_FLIGHT_POST_HEADROOM = 25` (shown in status). Any
inconsistent/unavailable state ⇒ no connection. The Developer Console spending limit is the
recommended independent backstop (`platformSpendingLimitVerified: UNKNOWN`).

**Rules (§16–§19).** Deterministic bounded manifest from the configured universe: lane A
origin (`($BTC OR #BTC …) -is:retweet`), lane B event (asset × bounded catalyst vocabulary,
`-is:retweet`), lane C approved accounts (`from:`; no default list), lane D propagation
focus (echoes allowed; EMPTY by default). Serpent-owned tags `serpent:v1:<lane>:<hash16>`;
reconcile only while disconnected: GET → dry-run desired additions → add → delete ONLY stale
Serpent rules → verify exact set; unowned rules survive byte-for-byte; insufficient capacity
⇒ fail closed. No blank, whole-firehose, or naked catch-all rule (`crypto`, `bitcoin`,
`pump`, … alone) can pass `validateXRuleManifest` — refused before any API call. Pump
language is never a blanket exclusion; X rules are a cost/relevance net, not a pump filter.

**Transport (§20/§36–§38).** Dedicated bounded HTTP streaming client (`rumor2/x-stream.js`),
exact host `api.x.com`, bearer only in the Authorization header (never logged), bounded
line parser, keepalive/stall reconnect with backoff, one connection only, 401/403 ⇒ stop,
420/429 ⇒ bounded backoff then stop. Post fields requested: `id,text,author_id,created_at,
edit_history_tweet_ids,referenced_tweets,conversation_id,lang,public_metrics,entities,
possibly_sensitive,withheld` — NO expansions, NO user.fields (no $0.010 User reads).

**Mapping (§22–§27).** Stable `nativePostId` = first id of `edit_history_tweet_ids` (fallback
`data.id`); `nativeVersionId` = current id; CREATE vs EDIT accordingly. `nativeAuthorId` =
`author_id`; handle/authorMeta null. `retweeted→REPOST`, `quoted→QUOTE`, `replied_to→REPLY`,
none→ORIGINAL, multiple/unknown→UNKNOWN (no fabricated priority; thread kept via
`conversation_id`). `created_at` → `sourceDeclaredTs` under the quarantine law;
`providerEventTs`/`providerEventSeq` null (never invented). `public_metrics` → first-known
engagement (views = `impression_count`). `matching_rules` → bounded sorted `ingressTags`
(Serpent-owned verbatim, others `external:unowned`), first-known, diagnostic only.

**Continuity (§28–§35).** No cursor is invented for X. `RUMOR2_SOCIAL_X_RULESET` records the
active rule set + coverage epoch (activated now, never backdated); `RUMOR2_SOCIAL_X_PROGRESS`
is the time watermark (all lines received through it are terminal; never past an unsettled
or dropped Post); `RUMOR2_SOCIAL_X_GAP` records explicit absence (budget/operator stop,
unexplained gap, writer loss, auth/connection failure). A settle appends
`[ruleset?][evidence…][meter][progress][gap?]` as ONE epoch-fenced atomic batch; adoption
only after commit. Reconnect elapsed ≤ 4 min from DURABLE progress ⇒ `backfill_minutes=5`
(overlap deduped, still metered); longer unexplained ⇒ WITHHELD_GAP, gap event, then a NEW
coverage epoch — never silent live-tail continuity. Queue full ⇒ pause; progress never
passes the owed Post. Writer loss ⇒ X (and Bluesky) stop immediately; nothing advances.

**Collector (§39).** The collector drives Bluesky and X as a bounded set of social runtimes
under the same writer fence, epoch, and journal; restore hydrates both from the journal.
`status.socialX` exposes gate, credential presence (boolean), state, `authority: NONE`, rule
set/epoch, stream, progress, gaps, meter, budget (remaining reads/USD, headroom), server usage,
credits, reads by lane. Zero authority is unchanged: no claim, proposition, Attention, HYPED,
eligibility, score, size, order, execution, or model call.

---

## 5D. PAID-WIRE SAFETY SEAL — smoke envelope, chunk-atomic stop, unowned-rule immutability

Three bounded defects were audited in the SOCIAL-2B tree (`fdff69a`) and sealed before an
operator is told to run the first paid smoke. Nothing about the pump doctrine, Bluesky, or
the frozen RUMOR-2 core changed.

**RED #1 — the documented smoke could not start.** The allowance law subtracts the pinned
in-flight reserve (`X_IN_FLIGHT_POST_HEADROOM = 25`) from EVERY limiting cap, including the
smoke cap. A `RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS=20` smoke therefore computed
`remaining 20 − headroom 25 = −5` and was refused (`BUDGET_SESSION`) before any connection.
The reserve is correct and stays: a stop request cannot un-send Posts the server already
buffered. The smoke budget now distinguishes TARGET from hard authorization:

| variable | meaning |
|---|---|
| `RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS` | the conservative delivered-Post count at which Serpent begins a controlled smoke shutdown |
| `RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS` | the operator's OUTER authorization envelope for the smoke, INCLUDING the in-flight reserve |

Law (`xSmokeLaw`): `TARGET > 0`, `MAX > 0`, `TARGET + X_IN_FLIGHT_POST_HEADROOM ≤ MAX`.
One variable without the other ⇒ `SMOKE_BUDGET_INCOMPLETE`; `TARGET + headroom > MAX` ⇒
`SMOKE_BUDGET_TOO_SMALL` (the detail names the minimum MAX). Both fail closed in the gate,
before the usage preflight, before any request. An operator-entered value is never
reinterpreted (20 is never silently 45); `status.socialX.smoke` shows target, max, headroom,
`minMaxForTarget`, session reads, and the nominal USD at MAX. TARGET is the stop trigger
itself (`SMOKE_TARGET_REACHED`, not headroom-subtracted); MAX joins the strictest-boundary
law as `BUDGET_SMOKE_MAX`. The daily / monthly / USD caps, `/2/usage/tweets` preflight,
project cap, credit handling, and writer fence all remain required — the smoke pair is an
ADDITIONAL limit, and the strictest boundary always wins.

Valid example envelopes at the pinned census price ($0.005 / Post read, observed
2026-09-06; prices change — the usage preflight, not this table, is authoritative):

| TARGET | minimum MAX (TARGET + 25) | nominal USD at MAX |
|---|---|---|
| 10 | 35 | $0.175 |
| 20 | 45 | $0.225 |

A TARGET=20 smoke has NO mathematically hard $0.10 ceiling; its outer envelope is 45 reads
nominal, and the Developer Console spending limit / finite credit balance remain the
recommended independent account-level backstop.

**Zero-spend default is absolute.** No smoke request unless ALL of: `RUMOR2_SOCIAL_X_ENABLED=true`,
`X_BEARER_TOKEN`, daily cap, monthly cap, daily USD cap, `LIVE_SMOKE_TARGET_POST_READS`,
`LIVE_SMOKE_MAX_POST_READS`, plus a green usage preflight, credit capability handling, rule
reconciliation, and a held writer fence. A token that merely exists authorizes nothing.

**RED #2 — a stop inside `onLine` did not end the current decoded chunk.** One `reader.read()`
carrying three complete Posts with `stop()` called at Post 1 delivered all three AND the loop
issued another `reader.read()` before noticing the stop. Delivering the three is CORRECT (X
already sent them; hiding them would violate BILL AT THE WIRE); the extra read was not. The
transport now implements the **chunk-atomic stop law**:

1. one `reader.read()` = one network chunk; every complete newline-delimited item already in
   it is parsed and delivered; the runtime meters every complete Post resource;
2. a `stop()` / `pause()` requested from inside the chunk is only PENDING (`stopPending` /
   `pausePending` in status) — the remaining already-received lines are still delivered
   and metered, offered to intake, and settled if admitted;
3. at CHUNK END the transport calls `onChunkEnd({ receivedTs, lines, keepalives, stopPending,
   pausePending })`; the runtime finalizes the stop reason and records the coverage gap at the
   chunk's LAST fully processed line (never before evidence it actually received — the
   watermark, the evidence `retrievedTs`, and `gapStartTs` share the transport receipt clock);
4. then the transport closes/aborts and the loop exits; the read loop checks
   `stopped || paused` BEFORE every `reader.read()`, so a finalized stop never asks the wire
   for another chunk (`status.reads` / `readsAfterStop` prove it).

**Hard MAX overrun truth.** The local reserve reduces risk; it cannot control how many Posts
X placed in a chunk before Serpent could react. If the final received chunk drives the
conservative meter past the smoke MAX, Serpent meters every delivered Post (never clamps or
discards the count), stops before any new read, sets `SMOKE_HEADROOM_OVERRUN`, records the
exact `overrunPosts`, records the gap with that reason, and LATCHES: `start()` and the
allowance refuse (`no automatic paid reconnect; a fresh operator-authorized start is
required`). A completed smoke (`SMOKE_TARGET_REACHED`) latches the same way.

**RED #3 — unowned rules were verified by count only.** `finalUnowned.length ===
unowned.length` passed a same-count mutation (an external rule's value changed during
Serpent's add). Reconciliation now takes a canonical closed snapshot of EVERY non-Serpent
rule — `{ id, value, tag: tag ?? null }`, sorted by id, value, tag — before mutation and
requires deep canonical equality after. Any disappearance, unexpected addition, id/value/tag
change ⇒ `RULE_RECONCILE_FAILED` with code `UNOWNED_RULESET_CHANGED_DURING_RECONCILE`, NO paid
stream, and no attempt to delete, restore, or "repair" someone else's rule. A concurrent
external change is not treated as corruption: a later preflight simply retries from the new
actual project state. Serpent ownership (`serpent:v1:<lane>:<hash>`), dry-run before
additions, capacity check, deletion of Serpent-owned ids only, the exact final Serpent set,
and reconciliation only while disconnected are all preserved — this seal strengthens
verification only.

Tests: `test/x-paid-wire.test.js` (SMOKE-RED-1, SMOKE-LAW-1, SMOKE-IMPOSSIBLE, SMOKE-ZERO,
X-CHUNK-RED-2, X-CHUNK-2/3, SMOKE-TARGET, X-FINAL-CHUNK, SMOKE-OVERRUN, BUDGET-CHUNK,
X-WRITER-LOSS-CHUNK, RULE-RED-3, RULE-SNAPSHOT, RULE-SEAL-1..6). Live paid smoke: NOT RUN
here — no bearer and no smoke pair were present, which is the expected safe result.

---

## 5E. DURABLE PAID-SMOKE AUTHORIZATION SEAL — run ID, durable baseline, completion latch

Audit of `e9c56de` reproduced one paid-smoke crash-boundary defect: a completed smoke
(`SMOKE_COMPLETE`, latched, 1 delivered) restarted as a fresh zero-count smoke — runtime B
restored the durable daily/monthly meter (1/1) but `meter.session = 0`, `latched = false`,
and `start()` opened a NEW paid stream. Likewise a mid-run crash (TARGET 10, 8 durable)
resumed with a full envelope instead of the remaining 2. A process restart is not a new
operator authorization to spend.

**Permanent law.** A paid smoke is a specific OPERATOR-AUTHORIZED RUN, never TARGET/MAX
numbers sitting in the environment. Each run has an explicit
`RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID`: required whenever TARGET/MAX are configured, ignored
otherwise, bounded to `^[A-Za-z0-9._:-]{8,64}$` (a UUID is fine, e.g. `smoke-2026-09-06-001`),
authorization identity — not a credential, never a secret. Serpent NEVER generates one (no
`randomUUID`, `Date.now`, PID, boot id, nonce): an auto-generated ID would turn every restart
into a "new authorization", which is exactly the defect. TARGET/MAX without a run ID ⇒
`SMOKE_RUN_ID_REQUIRED`; malformed ⇒ `SMOKE_RUN_ID_INVALID`; both are gate refusals before any
request. Without smoke variables, normal X gates behave exactly as before.

**Durable smoke-run event.** `RUMOR2_SOCIAL_X_SMOKE` (closed keys, identity
`r2xk-` over `{provider, smokeRunId, status}`) in the ONE PostgreSQL RUMOR event root — no
smoke store. Statuses: `ACTIVE`, then exactly one terminal `COMPLETE` / `HEADROOM_OVERRUN` /
`ABORTED`. It carries the run ID (raw, bounded), target/max/headroom, the pinned unit price,
the rule-set hash + coverage epoch it was authorized against, the durable baseline
(`baselinePeriod` UTC day, daily + monthly meter at activation, fresh server project usage
from the mandatory `/2/usage/tweets` preflight), `activatedKnownAtTs`, and on terminal:
`deliveredPostReadsForRun`, `overrunPosts`, `terminalReason`, `completedKnownAtTs`. No
bearer, no environment blobs.

**ACTIVE is durable BEFORE the paid stream opens (two-phase).** Order: run ID + envelope
validated → usage/credit/rule preflight green → writer fence held → the ACTIVE event with
its baseline is built → `start()` returns `SMOKE_ACTIVATION_PENDING` (state
`SMOKE_ACTIVATING`) → `settle()` appends it under the current writer epoch (after any
rule-set activation event in the same batch) → adoption → ONLY a later `start()` that sees
the DURABLE run opens the paid stream. The collector's tick already runs start-then-settle,
so activation costs one tick and no collector change. A crash before the commit leaves no
run (zero spend; the same run ID may retry); a crash after the commit resumes the SAME run
from 0 with one activation identity.

**Per-run count is durable arithmetic.** `conservativeDeliveredForRun = max(local durable
meter delta since the baseline within the baseline UTC day, server project-usage delta since
the baseline)`. `meter.session` remains a process diagnostic only. Other project consumers
can only make the count LARGER (safe); usage is never subtracted to make a smoke bigger. On
resume, a server delta above the local delta is ADOPTED into the conservative meter (lost
in-memory reads from a crash mid final chunk are never free — §19/§20); a server usage RESET
across the run (usage below the baseline) is `SMOKE_USAGE_RESET` ⇒ ABORTED. TARGET fires on
this count (`SMOKE_TARGET_REACHED`); MAX joins the strictest-boundary law as
`BUDGET_SMOKE_MAX`; daily/monthly/USD caps, project cap, credits, and the writer fence still
bind. After a restart with 8 durable Posts and TARGET 10, exactly 2 remain.

**Terminal state is durable and latches.** At the controlled target stop: `COMPLETE`
(`SMOKE_TARGET_REACHED`, exact count). At a reserve overrun in the final received chunk:
`HEADROOM_OVERRUN` (`SMOKE_HEADROOM_OVERRUN`, exact overrun, exact count, never clamped).
The terminal event settles in the SAME fenced batch as the final evidence, meter, progress,
and gap. On restart the same run ID ⇒ `SMOKE_RUN_ALREADY_COMPLETE` / `SMOKE_RUN_ALREADY_TERMINAL`,
zero stream requests. A restart, a day rollover, unchanged TARGET/MAX, an existing bearer, or
remaining daily budget are NOT consent: a new paid smoke requires a NEW explicit run ID.

**Binding laws (fail closed, never reinterpret a historical run).** Same run ID with a
different TARGET/MAX/headroom ⇒ `SMOKE_RUN_CONFIG_MISMATCH` (refused; the original envelope
still resumes). Verified rule-set hash differs from the run's activation hash ⇒
`SMOKE_RUN_RULESET_MISMATCH`, run ABORTED, new run ID required after reconciliation. Pinned
unit price differs from the activation price ⇒ `SMOKE_RUN_PRICING_CHANGED`, ABORTED. A paid
smoke may not span a UTC-day boundary: `SMOKE_PERIOD_ROLLOVER` ⇒ ABORTED with the run's
frozen count (never reset), whether detected at restart or at the chunk end of an ACTIVE
stream (the after-midnight Post is still metered). A new run ID while a crashed run is still
ACTIVE supersedes it explicitly (`ABORTED` / `SMOKE_RUN_SUPERSEDED`) in the same batch,
before the new activation — never two ACTIVE runs.

**Non-target interruption policy (§22, chosen and documented).** Every interruption Serpent
CAN record durably ABORTS the run with its reason — budget caps, credential rejection,
connection limit, unexplained gap (> 4 min) on resume, period rollover, rule-set / pricing /
usage-reset mismatches. Interruptions it CANNOT record (a crash, writer loss — nothing may
be appended without the fence) leave the run durably ACTIVE, and it resumes under the SAME
run ID only through the full current preflight (usage, credits, rule reconciliation with the
canonical unowned snapshot, writer fence), the gap law, and the server-usage delta law.
Durable run state authorizes the RUN; it never bypasses current safety. There is no
surprise automatic paid resume: a completed, overrun, or aborted run never reconnects.

**Replay validation.** `replaySocialHistory` fails closed on: duplicate activation with an
altered payload, activation twice, a second ACTIVE while one is ACTIVE, activation outside
the active coverage epoch, a baseline ahead of the durable meter (or claiming reads in a
period without one), terminal before ACTIVE, terminal after terminal, terminal fields
disagreeing with the activation (target/max/headroom/price/rule set/epoch/baseline), a
terminal count below the durable meter delta, unknown status / terminal reason / provider,
malformed run ID, pricing/ruleset fields malformed, COMPLETE below target, HEADROOM_OVERRUN
counts that disagree, ABORTED with a completion reason. Shape alone is never trusted.

**Status (`status.socialX.smoke`).** configured, run ID + hash prefix, durableStatus,
activationPending / terminalPending, target/max/headroom, baseline (period, daily, monthly,
server usage), conservativeDeliveredForRun with its local and server deltas, targetRemaining,
maxRemaining, overrunPosts, activatedKnownAtTs, completedKnownAtTs, terminalReason,
ruleSetHash, unitPriceUsd, resumedAfterRestart, activeRunId / latestRunId. No bearer.

Tests: `test/x-smoke-durable.test.js` (SMOKE-RUNID-1, SMOKE-ACTIVATE, SMOKE-DUR-1..10,
SMOKE-PRICING, SMOKE-INTERRUPT, SMOKE-SUPERSEDE, SMOKE-NORMAL, SMOKE-REPLAY,
SMOKE-ZERO-SPEND + AUTHORITY) and `test/x-collector.test.js` XCOL-5 (PostgreSQL, through the
collector tick). Live paid smoke: NOT RUN — no bearer and no run ID were present, which is
the expected safe result.

---

## 5F. SOCIAL-3 — Reddit: classification-neutral access foundation + retention firewall

**This is a provider-foundation and policy-boundary ticket, not activation.** No Reddit API
request, OAuth exchange, scraping, application, payment, or production change is authorized
or performed. Reddit is NOT an operational ear. A blocked provider foundation is not proof
that the intelligence layer is complete.

**Accurate project description (recorded, machine-readable in `REDDIT_USE_CASE`).** Serpent is
a private, single-user personal prototype. It is not offered to customers or sold as an
application or service. Its intended progression includes personal research, autonomous
paper trading, and possibly later autonomous trading of the owner's own funds — that
financial objective is disclosed, never omitted. No business, academic, nonprofit,
research-program, or moderator affiliation is claimed. "Theoretical prototype" establishes
no permission to retrieve or retain a third party's data.

**Classification is UNRESOLVED — not invented.** Neither "Serpent is definitely commercial"
nor "Serpent is private, therefore exempt" is assumed. The census entry separates the
questions and answers each on its own:

| question | recorded state |
|---|---|
| platformPath | `DOCUMENTED_OFFICIAL_PATH` |
| useCaseClassification | `UNRESOLVED` (only Reddit's use-case review classifies it) |
| approvalStatus | `NOT_VERIFIED` |
| additionalAgreementRequirement | `UNRESOLVED` (a requirement only when applicable terms or Reddit's decision establish it) |
| retentionCompatibility | `UNRESOLVED` |
| liveStatus | `DISABLED` |
| durableContentAllowed / durableAuthorIdentityAllowed | `false` / `false` |

No `requiresCommercialContract: true` and no `nonCommercialExempt: true` is hard-coded. An
approved non-commercial personal-use path (`APPROVED_NON_COMMERCIAL_PERSONAL`), an approved
use that carries additional terms (`APPROVED_WITH_ADDITIONAL_TERMS`), and an approved
commercial use (`APPROVED_COMMERCIAL`) are all representable; no valid approval is rejected
merely because it is not called "commercial".

**Sources reviewed (accessed 2026-09-06; summaries, not policy text).**
[R1] Responsible Builder Policy — API data access requires explicit approval and honest
disclosure of purpose and scope; "personal" or "research" confers no approval by itself.
[R2] Developer Platform & Accessing Reddit Data — app/use-case review determines eligibility
and commercial vs non-commercial approval; the published examples do not settle this
single-user personal-trading scenario, and no academic research route is assumed.
[R3] Developer Terms §4.1 — direct/indirect revenue and business/monetized-product
restrictions; whether personal trading falls within them is not resolved here.
[R4] Data API Terms §§2.4, 3.1, 3.2, 6 — a separate agreement may be required; permission is
use-specific (a token is not a license for every downstream use); storage, derived uses,
termination, and model-training rights are separate checks.
[R5] Reddit Data API Wiki — OAuth + descriptive User-Agent; free-eligible reference rate 100
QPM per OAuth client id averaged over ten minutes (technical context, NOT an entitlement);
deleted content and deleted-account identifying data must be removed; the routine 48-hour
deletion window is guidance, not a license to retain anything for 48 hours.

**Approval is evidence, not a magic boolean.** There is no `REDDIT_COMMERCIAL_APPROVED`
gate. A small closed operator record (`RUMOR2_SOCIAL_REDDIT_APPROVAL_*`: reference label,
status, application, reviewed use-case version, classification, permitted uses, additional
agreement + satisfied, validity, retention compatibility, reviewed-on) is evaluated by
`evaluateRedditAccess`. Its best outcome is `OPERATOR_ATTESTED` — an operator attestation,
never machine proof that Reddit issued permission. Missing, pending, expired, revoked,
denied, out-of-scope (another application or use-case version), unclassified, or malformed
records confer nothing; an unknown enum fails closed. The evaluation clock is an explicit,
validated input (a supported epoch-ms integer; the helper never substitutes a wall clock), a
supplied review date must not lie in the future of that clock, and the readiness summary
`activationPrerequisitesMet` is derived by one rule — every recorded prerequisite true AND
zero blockers — so a blocking reason can never coexist with readiness; informational notes
are `advisories`, never blockers. Retrieval permission never expands to
inference, model training, derived features, or redistribution (separate `permittedUses`).
Private correspondence and contract text stay out of Git, logs, the journal, and status.
This foundation contains NO live networking that a record or flag could switch on
(`liveAllowed` is always false, `FOUNDATION_ONLY_NO_LIVE_PATH`); activation is a later ticket.

**Retention is a separate boundary (§8/§9).** The immutable RUMOR journal cannot erase an
individual user's retained content, so a Reddit integration must not assume its permitted
retention fits that storage model. Until the applicable permissions and a compatible design
are reviewed: immutable content journal allowed = false; immutable author-identifying
journal allowed = false; live ingestion = false. Credentials, a personal-use description, or
a generic access approval never turn these true; a future agreement does not automatically
waive erasure requirements; hashes, pseudonyms, embeddings, derived features, and encryption
are not compliance loopholes. Enforcement is at every application boundary, by TWO
independent locks — the closed code constant `SOCIAL_RETENTION_PROHIBITED_PROVIDERS` in
`rumor2/social.js` and the registry flag `retentionProhibited` (asserted to agree):
`normalizeSocialObservation` refuses, `socialObservationToEvent` refuses,
`validateSocialEvent` refuses (a caller allowlist can only narrow, never authorize),
`replaySocialHistory` fails closed, and Social intake rejects before anything reaches an
append callback. This is the supported application boundary; it makes no claim about a
privileged database administrator inserting raw SQL. No UPDATE/DELETE of journal history,
no content vault, and no purge of existing history were added.

**Fixture-only preview adapter (`rumor2/social-reddit.js`, §10–§12).** Wholly synthetic
fixtures shaped like official Data API things (`t3` posts, `t1` comments) map to an
IN-MEMORY preview distinct from the durable Social observation: native fullname identity
(post and comment namespaces distinct; never a content hash), subreddit context, title and
body, parent/link/crosspost references (ambiguity stays `UNKNOWN`), `created_utc` as the
source-declared clock classified by the SAME quarantine law as every other ear (malformed ⇒
UNKNOWN, ahead of retrieval ⇒ FUTURE_QUARANTINED, no wall-clock fallback; retrieval/known-at
are caller-supplied acquisition facts), available engagement (score, ups, comment count,
upvote ratio; absent ⇒ null), provider-supplied edit state without any invented version id,
and deletion/removal that reveals content is gone without reconstructing text or inferring a
reason beyond the provider's own category. Author identity is the immutable account fullname
when supplied, otherwise `UNKNOWN`; a username is display metadata; no profile is fetched.
Original fixture text is kept separate from the deterministic derived preview. No raw blob,
live fetch, timer, subscription, credential exchange, or persistent cache exists.

**OAuth / rate-limit foundation (§13).** Pure request description (host `oauth.reddit.com`,
`/r/<subreddit>/<listing>`, bounded query, documented descriptive User-Agent shape,
credential NAMED never valued) and a rate-header parser. The future runtime allowance law is
pinned: min(approved scope cap, configured cap, observed remaining). Only documented decimal
header strings (or finite non-negative numeric fixtures) are accepted; booleans, arrays,
objects, empty strings, exponent/hex/signed syntax, NaN, Infinity, negatives, out-of-bound
values, and missing headers or caps yield zero; the published 100 QPM reference is never a
default. No token exchange, no polling loop.

**DRAFT ONLY — the question Reddit must actually answer (not a submission):**
"Private application for one owner, not sold or offered as a paid service. It would analyze a
bounded set of crypto-related public posts/comments for the owner's personal research and
paper trading, with possible later use for automated trading of the owner's own funds.
Please confirm the permitted access route, classification, downstream analysis/model-use
permissions, and applicable storage/deletion requirements."
Inference, model training, data redistribution, and persistent derived features are
separate proposed uses; approval for retrieval must not be silently expanded to cover them.

**Outstanding before any live-activation ticket:** (1) Reddit's actual approval of this
use case with its classification; (2) whether a separate agreement is required and, if so,
satisfied; (3) the permitted retention/deletion obligations and a compatible durable design
(the current immutable journal cannot erase individual content); (4) the permitted downstream
uses (analysis, inference, derived features) confirmed explicitly; (5) an approved rate scope
and configured caps; (6) credentials. None of these is inferred from the others.

Tests: `test/social-reddit.test.js` (REDDIT-CENSUS, REDDIT-A..J, REDDIT-FIREWALL-1..4,
REDDIT-FIXTURE-1..4, REDDIT-REQUEST, REDDIT-NO-LIVE), `R2A-SOCIAL-5` (explicit filename
allowlist, Git-index-aware), CENSUS-3 pin. Bluesky, X, the frozen core, and the pump doctrine
are unchanged.

---

## 5G. SOCIAL-4B — StockTwits: inventory truth, route-specific access/retention firewall, fixture-only Firestream foundation

**Two different things exist for StockTwits, and the inventory now says so.**

1. **The legacy aggregate RUMINT ear** (`rumint/*`, `persistence/rumint-checkpoint.js`, wired in
   `fly.js`). Status: **CONFIG-ENABLED LEGACY IMPLEMENTATION; DEPLOYED STATE UNOBSERVED.** The
   committed `cobra.config.json` has `rumint.enabled: true`; `RUMINT_ENABLED`, when defined,
   overrides it. It polls the legacy symbol REST route into hourly statistics, reading only
   message id, `created_at`, and the author's sentiment label; it stores no post bodies or
   author profiles, but does keep a bounded recent message-id cache and poll evidence — an
   identifier is not permission-free merely because text is discarded. Its documented outputs
   are preserved exactly (RUMINT.md): qualifying statistics **nominate** a symbol into the stalk
   set (posture COILED→STALKING, the microstructure tracking set, cockpit attention) and the
   canonical **HYPED** snapshot exists as future confirmation-strictness metadata. Neither is
   order or strike permission. Preserving this code is not a new endorsement of its unresolved
   route; this ticket neither switches it on nor authorizes continued access. It is described in
   a small immutable descriptor (`STOCKTWITS_LEGACY_RUMINT`) — reporting only, no imports of
   rumint/state/ui/persistence — and is **not** relabeled "not built", "verified live", or
   "approved".
2. **The NEW raw Social path** (`rumor2/social-stocktwits.js`): fixture-only, zero nomination,
   attention, HYPED, claim, proposition, order, or execution output; no runtime acquisition; no
   durable raw content or author retention. Its documented legacy effects are not inherited.

**Route-specific census (retrieved 2026-09-06; short paraphrases, no copied terms).**

| route | fact | uncertainty |
|---|---|---|
| SELF_SERVE_REGISTRATION (S1) | new registrations paused pending review; contact by email | silent on existing entitlements, other products, pricing, terms |
| LEGACY_SYMBOL_REST | used by legacy RUMINT (`/api/2/streams/symbol/<sym>.json`) | documentation `UNVERIFIED_IN_THIS_ENVIRONMENT`; entitlement and permitted use unresolved |
| FIRESTREAM_MESSAGES (S2/S3) | `firestream.stocktwits.com/stream`, HTTP Basic with a stream-authorized account; envelope `{object, action create/destroy, data, time, seq_id}`; objects Message, Friendship, Block, LikeMessage; `seq_id` opaque, recovery up to 24 h | no completeness/SLA; a destroy signal is documented (correcting the read-only report) but complete deletion delivery, retention rights, and edit semantics are not established |
| FIRESTREAM_SYMBOL_ACTIVITY (S5) | activity events (pageview, watchlist, message, like) | not originating message content; not corroboration |
| FIRESTREAM_REFERENCE (S4) | `symbol_id`, `ticker`, `exchange`, `country`, `asset_class`, `delisted` (+isin/cusip); current-state snapshot | no point-in-time history; never used to improve an older observation retroactively |
| FIRESTREAM_BACKUPS (S6) | daily gzip NDJSON, 302 to a presigned link; `seq_id` absent | retention window, completeness, lifecycle coverage, id equivalence unstated; never downloaded here |

General Terms (S7, "Last Revised: July 10, 2026"): §1 offering-specific terms prevail; §5 no
unauthorized automated or scraping access, authorized APIs/developer offerings permitted; §8
users own content, the platform holds a broad license and may license public content (including
usernames where applicable) to institutions, and deletion does not remove prior grants from
backups, archives, and deidentified datasets; §18 suspension/termination. Privacy (S8, July
2026): public content may be visible to API users and partners; platform retention "as reasonably
necessary". Neither page is this account's Firestream entitlement nor a license for Serpent's
storage or inference; the platform's own retention never authorizes Serpent to retain the same
data. The read-only report's "no StockTwits terms were readable" is withdrawn.

**Private use, classification UNRESOLVED.** Private single-user personal prototype; not sold or
offered to customers; personal research, autonomous paper trading, possibly later automated
trading of the owner's own funds; no claimed affiliation. Not assumed commercial, not assumed
exempt. Separate questions, never derived from one another: documentation exists; an account is
entitled to a particular route; Serpent's use is permitted; additional terms are required/not
required/unresolved; content and identifier retention is compatible; derived features,
inference, training, and redistribution are separately permitted; rate/pricing scope is known;
credentials are available. No probe is authorized to test any of them.

**Access summary (`evaluateStocktwitsAccess`).** A closed bounded operator record (reference
label, route, attested status, application, use-case version, permitted uses, additional terms,
validity, retention compatibility, reviewed date; no credentials, correspondence, account
identity, or contract body) yields at best `OPERATOR_ATTESTED` — never platform proof. The clock
is an explicit validated input (no wall clock; missing ⇒ `CLOCK_UNAVAILABLE`, invalid ⇒
`CLOCK_INVALID`); a future review date is `REVIEW_DATE_IN_FUTURE`; an absent expiry stays absent.
Access-date precision law (seal of b86278f): `reviewedOn` and `validUntil` share ONE strict
interpretation (`stocktwitsAccessDate`, the same local calendar parser as the preview — never
`Date.parse`, never the host zone, never numeric/prose coercion, never calendar rollover), parsed
once per evaluation and used identically by validation and readiness. A calendar-valid
`YYYY-MM-DD` is a UTC calendar-day LABEL; an explicit-offset `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`
is an exact instant; anything else supplied (offset-less date-time, impossible date, bare number,
prose, sub-millisecond fraction, wrong type, empty/oversized) is `ACCESS_RECORD_INVALID` naming the
field — never treated as absent, never repaired. `reviewedOn`: a day label passes only when it is
no later than the UTC calendar day of `nowMs` (it never proves the review instant); an instant is
compared exactly; absence keeps the pre-existing optionality and is labelled by the advisory
`REVIEW_DATE_NOT_SUPPLIED`. `validUntil`: an instant is valid only while `nowMs < expiry`
(equality is expired, no grace, no rounding); a day label names no expiry instant or zone, so the
declaration is kept and readiness is blocked as `VALID_UNTIL_PRECISION_UNRESOLVED` — Serpent does
not assume end-of-day, +24h, the host zone, or UTC midnight on the platform's behalf (a
conservative readiness decision, not a platform or legal claim; an approved live contract must
supply its own expiry interpretation); `null` means no expiry supplied, not an everlasting licence.
Results are identical in every host time zone. No date grants entitlement.
Readiness = every prerequisite AND zero blockers; informational notes are advisories. Even a
fully permissive synthetic record leaves `liveAllowed=false`, `liveStatus=DISABLED`,
`liveReason=FOUNDATION_ONLY_NO_LIVE_PATH`, `durableContentAllowed=false`,
`durableAuthorIdentityAllowed=false`, and returns no transport or writer.

**Raw Social retention firewall.** `STOCKTWITS_OFFICIAL` joins `SOCIAL_RETENTION_PROHIBITED_PROVIDERS`
(the registry flag `retentionProhibited` is asserted to agree). Before this ticket every generic
Social boundary accepted a StockTwits-shaped raw observation (normalize, event build, validate,
replay, intake). Now all five refuse with `RETENTION_NOT_APPROVED: STOCKTWITS_OFFICIAL …` before
any append callback; no caller allowlist, enabled flag, credential, attestation boolean,
"personal use" or "source-only" label, or content hash bypasses it. The reason is that route
entitlement, permitted downstream use, and raw-content/author retention compatibility are not
established for this project — NOT a claim that StockTwits imposes Reddit's deletion rule, and
the documented destroy action is not a retention license. The block never reaches the legacy
aggregate subsystem: `rumint/*` imports nothing from `rumor2/`, and no legacy baseline or
message-id cache is touched. The PostgreSQL journal API is unchanged; the guarantee is at the
supported application boundaries, not against a database administrator inserting JSON.

**Fixture-only Firestream preview (`firestreamEnvelopeToPreview`).** Input: a Firestream-shaped
envelope plus an explicit validated acquisition clock (no default). Dispatch on BOTH `object` and
`action`: `Message/create` → an in-memory MESSAGE preview; `Message/destroy` → a MESSAGE_REMOVAL
preview holding only the message id, with no prior body, author, thread, or creation time
recreated and no prior create required (`deletionDeliveryGuarantee: UNPROVEN`);
`LikeMessage`/`Friendship`/`Block` → `NOT_A_MESSAGE_LIFECYCLE_EVENT` (never a tombstone or post);
unknown object/action → `UNKNOWN_OBJECT_OR_ACTION`. Edit semantics are `UNRESOLVED`; no revision
id or content-hash guarantee is invented. Message, user, and symbol ids are canonical decimal
strings; numeric fixtures only when positive safe integers (an unsafe number is rejected, never
stringified); no coercion from booleans, arrays, objects, hex, exponent, or blanks. `seq_id` is an
opaque string preserved byte-for-byte within a syntax bound — never `Number()`, never
incremented, never a timestamp, never trimmed — carried in `delivery`, never in the frozen
numeric `providerEventSeq`. Cross-route id equivalence (REST vs Firestream vs backups) is
UNVERIFIED: no histories are merged and no provenance groups are manufactured. Text: bounded
original kept separate from a derived display preview; absence is null. Relationships
(fixture-truth correction of 504c85c): `in_reply_to_message_id` → REPLY, `parent_message_id` →
root, and the documented singular example `reshare_message.message.id` → RESHARE (only the
bounded target id is kept; the nested original body/profile is never a second observation; a
container-level `reshare_message.id` is not a supported variant and may only agree with the
nested target). A relationship-bearing field that is present but malformed (array, string,
boolean, number, invalid id, non-boolean `parent`), a reshare container without a target,
disagreeing variants, a self-reshare, a non-root signal without a reply target, or reply and
reshare evidence together → UNKNOWN with a `relationReason` — never ORIGINAL. ORIGINAL is a
structural label only (no well-formed reply/reshare relation, or a root explicitly established
by `parent: true` / a `parent_message_id` equal to the message's own id); it is never proof of
independent confirmation. Separately valid root facts are preserved; targets are never invented.
Reshare counts and resharer id counts are propagation metadata only. Profile context is bounded (user id,
handle, join declaration, follower/following counts, provider `official`/`identity`/
`classification` flags — a flag is never verification or corroboration); avatars, bios,
locations, links, prices, and media are ignored, not copied. Sentiment is the author's label,
descriptive only. Symbols keep provider `symbol_id` and observed ticker separately; there is no
`.X` inference and the legacy `${coin}.X` mapping is untouched; `resolveSymbolReference` matches
an explicitly supplied snapshot only when it was known no later than the observation
(`REFERENCE_KNOWN_LATER` otherwise), reports `TICKER_CONFLICT`/`NOT_IN_REFERENCE`, and never
labels anything tradeable. The snapshot is validated WHOLE before any matching: every row must be
a well-formed object with a canonical `symbol_id` and a valid ticker (optional `asset_class`
string / `delisted` boolean or absent), one canonical `symbol_id` per snapshot, bounded row count.
A duplicate `symbol_id` — identical or contradictory — refuses the whole snapshot as
`REFERENCE_CONFLICT`; a malformed row refuses it as `REFERENCE_ROW_MALFORMED` (offending row
index reported); nothing is ever selected by array order, first-wins, last-wins, or majority, and
no subset is described as a verified reference. Clocks: one small local parser (never
`Date.parse`) accepts a full instant only as calendar-validated `YYYY-MM-DDTHH:MM:SS[.fff]`
with an explicit `Z` or `±HH:MM` offset; a calendar-valid `YYYY-MM-DD` is DATE_ONLY with no
instant; an offset-less date-time is OFFSET_MISSING (the host zone is never assumed); more than
three fraction digits is UNSUPPORTED_PRECISION (never truncated); bare numbers, impossible dates,
leap seconds, and prose are MALFORMED — each preserved as declared with a null instant and an
UNKNOWN source-clock status, and the message evidence still survives. The same parser governs
`created_at`, envelope `time`, and `join_date`, which remain distinct clocks. Source declaration,
envelope lifecycle time, and Serpent acquisition time stay distinct; a valid explicit-offset
future instant is classified by the shared quarantine law (TRUSTED / FUTURE_QUARANTINED /
UNKNOWN), never rejected. Backups are historical provider data, not proof
Serpent knew it then. No resume cursor, gap repair, gzip, SSE framing, archive download, backoff,
or transport exists; a parsed fixture never claims a complete feed.

**Future single-acquisition / two-projection boundary (documented, not implemented).** After
entitlement and retention are resolved, ONE selected upstream acquisition may feed two separate
projections: the legacy RUMINT statistical calculation and source-only Social evidence for later
provenance analysis. Both descend from the same platform observation and can never count as two
independent corroborating sources. Only one acquisition path may feed a given legacy baseline: no
second symbol poller, no REST-to-Firestream replacement, no dual-run collectors, no change to the
legacy nomination threshold or cadence. Any migration must verify route identity/symbol/lifecycle
equivalence, prove statistical parity on controlled fixtures, preserve historical baseline and
coverage labels, record the collection-regime change, never mix full-stream counts with
sampled-poll baselines as if identical, preserve the nomination-versus-execution distinction,
resolve retention before retaining raw text, and recover without double counting. This section
authorizes none of that wiring.

Tests: `test/social-stocktwits.test.js` (ST-INVENTORY-1/2, ST-ACCESS-1..3, ST-FIREWALL-1..3,
ST-PREVIEW-1..6, ST-NO-LIVE), `R2A-SOCIAL-6` (explicit Git-index-aware allowlist), CENSUS-3/5 and
adversarial pins. No StockTwits network request, credential exchange, stream, archive download,
legacy poll, paid probe, support email, or application occurred.

---

## 5H. SOCIAL-4D — social temporal-input integrity + classification-neutral census

**The defect (independent review, reproduced at 809a139).** Every string-to-time entry point in
the Social layer used the generic `Date.parse` heuristic. Per the ECMAScript specification an
offset-less date-time is interpreted in the HOST time zone, a bare number is a year, and
impossible calendar dates roll forward. Reproduced with synthetic input under UTC, America/
New_York, and Asia/Kolkata: (a) Reddit access records — `reviewedOn` `'2026-09-06T12:00:00'`
was ready under UTC/Kolkata and `REVIEW_DATE_IN_FUTURE` under New York; the same string as
`validUntil` flipped the other way; `'2026-02-30'` and `'0'` were accepted as review dates;
(b) six provider clock paths (Farcaster cast + recast, Bluesky post + repost + `payload.time`,
X Post `created_at`) — `'2026-09-06T12:00:00'` became 12:00Z TRUSTED, 16:00Z
FUTURE_QUARANTINED, or 06:30Z TRUSTED by zone, changing the content-version identity;
February 30 became March 2; `'0'` became the year 2000; all reached valid durable events.

**The boundary (`rumor2/social-time.js`).** One pure module (no imports, no network/storage/
timer/wall-clock capability) validates BEFORE constructing any number: primitive string,
bounded length, complete grammar, leap-year and month-length calendar checks, time-of-day and
offset ranges, then UTC construction via `setUTCFullYear`/`setUTCHours` (years 0001–0099 stay
literal). Closed outcomes: `INSTANT`, `DATE_ONLY`, `ABSENT`, `OFFSET_MISSING`,
`UNSUPPORTED_PRECISION`, `UNSUPPORTED_RANGE`, `MALFORMED`. Policies are per producer, never
blind ISO acceptance: `AT_DATETIME` (atproto lexicon datetime: uppercase T/Z, no `-00:00`,
four-digit year ≥ 0001, arbitrary fraction), `RFC3339` (Neynar `format: date-time`: lowercase
and `-00:00` permitted), `ISO8601_PROFILE` (X `created_at`), `ACCESS_DATE` (operator dates:
day label or explicit-offset instant with ≤ 3 fraction digits). Sub-millisecond digits are
never silently "exact": under FLOOR policies the instant is the millisecond floor and
`subMillisecondRemainder` is flagged (`precision: MILLISECOND_FLOOR`); leap seconds and years
outside 0001–9999 are `UNSUPPORTED_RANGE`; extended six-digit years are outside every documented
grammar. A usable instant proves syntax only — TRUSTED remains "temporally usable under the
quarantine law", never authenticated publication time.

**Reddit (repaired here).** `reviewedOn`/`validUntil` share the `accessDate` interpretation,
parsed once per evaluation and used identically by `validateRedditApprovalRecord` and
`evaluateRedditAccess`: ABSENT (not supplied), INSTANT, DATE_ONLY (UTC day label), INVALID
(anything else supplied — never absent, never repaired). A day-label review passes only when no
later than the UTC day of `nowMs`; an instant compares exactly; absence keeps its optionality with
the advisory `REVIEW_DATE_NOT_SUPPLIED`. An instant expiry is valid only while `nowMs < expiry`;
a day-label expiry blocks readiness as `VALID_UNTIL_PRECISION_UNRESOLVED` (no start/end-of-day,
+24 h, host-zone, or perpetual-licence guess); `null` means no expiry supplied. Invalid dates
invalidate the record with a field-specific blocker. Results are identical in every host zone.
Live and durable permissions stay false; classification stays UNRESOLVED. Both entry paths
(direct record and the env reader's empty-as-unsupplied rule) are tested.

**Adapters — resolved in the SOCIAL-4D COMPLETION (§5I).** At d5db393 the six provider paths
stayed on the baseline parser because the corrected parser changed `sourceDeclaredTs` — a
provenance-identity fact — for formerly ambiguous declarations, so a naive redelivery would have
minted a different version. §5I closes that gate with an explicit event evolution and ONE
native-event reconciler, not with a duplicate source and not with a post-id-only match.

**Census corrections (facts, not authorization).** Farcaster: a published Free plan is not this
project's plan; terms retrieval failed; mapper present, no transport, key presence is
configuration only. Meta: routes distinguished; eligibility NOT ESTABLISHED; no commercial
classification asserted. TikTok: products distinguished; the Research route's 48 h indexing delay
is route-specific; the current decision is inactive with operator review pending — no permanent
exclusion was approved on the operator's behalf. Roadmap: the v5 migration reference was
obsolete (v4 retained, journal cursor events); the X paid smoke has not occurred.

---

## 5I. SOCIAL-4D COMPLETION — history-safe provider clock integration

**Witnesses (`rumor2/social-time.js`).** Each of the six clock paths (Bluesky `record.createdAt`
on posts and reposts, Jetstream `payload.time`, Neynar cast and recast `timestamp`, X Post
`created_at`) now produces a CLOSED, versioned `temporalWitness`: the declaration exactly as
received (≤ 64 chars; an oversized value keeps a prefix, its true length, and
`declaredComplete=false`, and is never parsed), a presence/type status (`STRING`, `ABSENT`,
`NON_STRING`, `OVERSIZED`) distinct from parse success, the policy id and immutable
`policyVersion`, the outcome, the millisecond PROJECTION (labelled as such), the fraction digit
count, and the exact bounded `subMillisecondRemainder` (a decimal digit string, never a float or
BigInt). Role policies are pinned per provider and field (`SOCIAL_CLOCK_POLICY_BY_PROVIDER`):
Bluesky records `AT_DATETIME`, Jetstream event time `JETSTREAM_EVENT_TIME` (pinned separately from
the record profile), Neynar `RFC3339`, X `ISO8601_PROFILE`. A valid protocol year outside Serpent's
supported range is `UNSUPPORTED_RANGE`, not "invalid syntax"; the post is kept in every case.

**Witnessed verdict.** Version-2 observations classify the source clock from the witness's
projection AND remainder against Serpent's integer-millisecond acquisition reference: BEFORE/EQUAL
⇒ `TRUSTED` (temporally admissible, never independently certified); AFTER ⇒ `FUTURE_QUARANTINED`
(+28 ms, +87 s, +1 day all retain the observation with bounded skew and no causal authority);
inside the acquisition millisecond ⇒ `ORDER_UNRESOLVED` (a floored projection may not call
T+0.5 ms earlier); no usable instant ⇒ `UNKNOWN`. Serpent measured integer milliseconds only; no
sub-millisecond arrival, synchronized-UTC accuracy, or clock-error tolerance is claimed. Zero
padding beyond milliseconds is not precision loss; non-zero digits survive into the witness and the
identity-independent `witnessHash`. `compareSocialInstants` orders two witnesses exactly and a
witness against an integer reference conservatively (`UNRESOLVED`, never a guessed earlier time).

**Event evolution.** The legacy `RUMOR2_SOCIAL_OBSERVED` shape, identity recipe, and diagnostic
hash are UNCHANGED and validate exactly the history they represent. New ingestion emits the
discriminated `RUMOR2_SOCIAL_OBSERVED_V2`: the legacy keys plus `schemaVersion: 2`,
`sourceClockWitness`, `providerEventWitness`, and `witnessHash`; its validator re-derives both
witnesses under the provider's role policies, requires the numeric clocks to equal their
projections, re-derives the witnessed verdict, and re-runs every legacy law. The version identity
recipe is unchanged (it binds the millisecond projection), so a valid exact instant keeps its
legacy `sourceEventId`; a v2 event cannot lose its witness fields and pass as legacy. Two closed
non-source types ride the same journal under the same writer authority and are validated on live
append and replay: `RUMOR2_SOCIAL_CLOCK_INTERPRETATION` (a dated annotation bound to one durable
target by type, id, full payload digest, native key, immutable-fact digest, role, basis, witness,
prior and re-derived interpretation, evidence acquisition time, and its own `knownAtTs`; identity
`r2si-` over target + role + policy version + interpretation digest, so retries and redeliveries
never mint another) and `RUMOR2_SOCIAL_RECONCILIATION_PENDING` (a bounded record of a candidate
whose identity/time match is genuinely unresolved: reason, native key, immutable digest,
candidate facts, witnesses, the candidate ids considered; identity `r2sp-` over provider + native
key + immutable digest + witness hash + reason). Neither counts as a social source, origin, author,
or propagation; both refuse retention-prohibited providers.

**ONE matcher (`rumor2/social-reconcile.js`).** Settlement in both runtimes reconciles every
witnessed candidate against the version-aware derived index (rooted only in validated replay and
maintained only after successful append) PLUS the earlier candidates of the same batch:
`NEW` (append one v2 source), `KNOWN` (keep-first; diagnostics, acquisition time, and verdict
changes never fork a version), `ANNOTATE` (a unique native-event match on exact retained text and
every immutable non-clock fact whose strict witness changes the interpretation: append only the
dated annotation(s)), `PENDING` (several candidates, insufficient occurrence identity,
conflicting immutable facts, or non-equivalent retained declarations). The native key is
provider + post + author + lifecycle + native version id + provider sequence: Bluesky commits with
different `seq` stay distinct (CREATE→DELETE→RECREATE→DELETE keeps both tombstones) and a
sequence-less Bluesky candidate facing candidates is `OCCURRENCE_IDENTITY_INSUFFICIENT`; X keeps the
stable post id and the current delivered Post id (a genuine edit is a new version); a Farcaster
cast hash + FID is a supported match while a recast edge (reactor+target only) with a changed clock
is retained as unresolved, never merged. Equivalent instants written with different offsets or
padding are the same instant under the documented rule while the first recorded string stays
intact; near-duplicate text, handles, or engagement never authorize a match. The cheap intake path
absorbs only exact, already-reconciled current-format redeliveries; a legacy-format durable row
facing a witnessed candidate always reaches settlement. Lookups are per event type; a lookup
failure is never "not found": the drained envelopes are retained and retried, nothing advances.

**As-of view (`rumor2/social-view.js`).** `socialTemporalView({ event, annotations, asOfTs })`
returns `ORIGINAL_RECORDED` (the immutable event; a legacy numeric clock is
`LEGACY_NUMERIC_UNVERIFIED`, never precision-verified) and `EFFECTIVE_AS_OF` (only annotations
whose own `knownAtTs ≤ asOfTs`, latest per role, ties by id). First-known time never moves; a
correction known at T1 is invisible before T1; nothing is mutated. The witness reconstruction
carries `schemaVersion`, `clockProvenance`, and both witnesses.

**Legacy corpus and proofs.** `test/fixtures/social-4d-legacy-d5db393-{UTC,America_New_York,
Asia_Kolkata}.json` were produced by the UNTOUCHED d5db393 code in an isolated worktree (78 cases
each: valid, offset, micro, padded, T+0.5 ms, three future offsets, offset-less, February 30, `'0'`,
lowercase, `-00:00`, missing, reply, seq 10/20, delete cycles, X edit, other cast hash, event
time). `test/social-4d-completion.test.js` drives the real adapter → intake → reconciler →
journal → replay/view chain over them, with PostgreSQL sections for legacy restore, append
failure, crash-before-adoption, stale-epoch takeover, and the collector validating Social history
with the provider gate OFF (a later enablement can never reveal unchecked history). The
redelivery of a legacy row keeps the row byte-identical and adds no logical source; physical
journal growth from annotations/pending records is legitimate and reported separately in status.
Production state remains unobserved: nothing was scanned, migrated, repaired, or activated.

---

## 5J. SOCIAL-4D CLOSEOUT — cursor obligations, identity-conflict routing, annotation consistency, as-of isolation

A repair of §5I, reproduced RED against the untouched 37b2dab runtime with synthetic inputs and
the in-memory journal (no provider data, no network) before any fix. Nothing here changes provider
access, retention firewalls, pump doctrine, journal/checkpoint schema, legacy identity recipes, the
frozen legacy validator, X bill-at-the-wire, or trading authority. Six laws:

**Duplicate receipt is not settlement of the first receipt (`rumor2/social-stream.js`).** The
intake's cursor obligation is `providerCursor → { owed, dropped }`: every queued envelope owns ONE
`owed` unit that only `settled()` (or a writer-loss `clear()`) releases; a queue-full drop sets
`dropped` until its replay is seen. A later delivery at the same cursor that reaches a terminal
disposition (filtered / skipped / rejected / deduped) refers to the existing obligation and never
deletes it — it only resolves an outstanding drop replay. `projectedCursor` releases exactly one
unit per envelope in the batch. A local seen-cache entry is therefore never a durable terminal
disposition, and a partial drain can no longer persist a cursor past an unsettled earlier frame. X
carries no numeric cursor and no obligation is invented for it; its queued-work watermark is
unchanged.

**One semantic equivalence law on every duplicate route
(`assessSocialEquivalence`, `rumor2/social-settle.js`).** The process-local cache keeps the
FIRST-SEEN equivalence record (exact immutable digest + retained witnesses), the durable fast
check, the exact-identity branch of the reconciler, same-batch dedupe, and restart/eviction paths
all conclude KNOWN / duplicate ONLY when (1) the EXACT immutable non-clock facts agree (a
case-folded similarity fingerprint cannot authenticate exact text), and (2) retained source
declarations are equal or equivalent (same projection and remainder). A differing provider EVENT
clock is delivery diagnostics and follows the first-known policy (no conflict record, no new
identity). Mutable handle/engagement/profile data and acquisition clocks stay keep-first. A fast
path that cannot establish equivalence DEFERS (the candidate is enqueued with a `deferred`
reason, never absorbed, never discarded). A journal lookup that reports an id unknown to the
hydrated index is an INDEX_DIVERGENCE: existence alone proves nothing, so nothing appends, no
cursor advances, the batch stays owed, and the runtime reports it until re-hydrated. Reconciled
marks for legacy targets are applied at ADOPTION, never at reconcile time, so a failed lookup or
append installs no cache entry.

**Missing a discriminator is not proof of a distinct occurrence (`rumor2/social-reconcile.js`).**
When the exact native key finds no candidate, the COARSE key (native key without the provider
sequence) is consulted only to detect uncertainty: a seq-less Bluesky delivery facing any known
occurrence of the same post version, or a sequenced delivery facing a known occurrence that itself
lacks its sequence, is retained `OCCURRENCE_IDENTITY_INSUFFICIENT` and linked to every potential
occurrence — never NEW, never absorbed, never given an invented sequence. Two distinct sequences
remain two occurrences; a first-ever record with no known occurrence follows the source contract.
Farcaster recast edges receive the same treatment; no Farcaster transport exists.

**Later arrival is not proof (`annotateOrKnown`).** For a legacy target, a candidate declaration is
compared with every declaration already retained for that target and clock role — durable
annotations AND annotations earlier in the same batch. Equivalent (same instant, or the same bytes
under the same policy version) ⇒ KNOWN, nothing appended; a non-equivalent complete declaration ⇒
an explicit `DECLARATION_CONFLICT` pending record naming the target, never a second annotation.
Existing historical annotations are never rewritten or deleted; `replaySocialHistory` accepts a
pre-closeout history that carries two disagreeing annotations, reports it in
`annotationConflicts`, and exposes `pendingByTarget` as the view's conflict context. A policy-version
reinterpretation of retained bytes is a different interpretation (never silently equal); an
unsupported witness version is refused at normalization and at annotation validation.

**Base-event admissibility precedes annotation selection (`rumor2/social-view.js`).** Before the
event's own first-known time `socialTemporalView` returns `status: NOT_YET_KNOWN` with no
ORIGINAL/EFFECTIVE data; source, declaration and provider clocks grant no earlier admissibility and
`firstKnownAtTs` is never backdated. The view exposes nothing about withheld future records (no ids,
no counts). When the eligible retained SOURCE declarations disagree (non-equivalent annotations, or
an eligible `DECLARATION_CONFLICT` record against this event), the effective source clock is
`UNRESOLVED_CONFLICT` with provenance `CONFLICTING_DECLARATIONS`, no winning declaration, and
`conflict.knownAtTs` = when the disagreement became known; before that time the earlier retained
declaration applies unchanged. Provider-event annotations apply first-known.

**Views are detached, deep-frozen snapshots.** Inputs (including JSON-deserialized journal rows)
are cloned before use and never frozen or mutated; every nested witness/interpretation reachable
from `original` or `effective` is frozen; original and effective cannot contaminate each other.

Expectation changes in existing tests, each required by these laws: the missing-sequence
candidate in the completion suite's group G is PENDING (was NEW); group H's tautological
assertion was replaced by concrete checks (no provider cursor for X, no sequence in the X adapter,
no cursor event); group J and N count every lawful duplicate route; group M no longer asserts a
withheld-annotation id list; RT-PG-3 expects the honest INDEX_DIVERGENCE refusal followed by a
KNOWN settle after re-hydration instead of a silent "learned" duplicate.

## 5K. SOCIAL-4D CORRECTION/CONFLICT RECORD INTEGRITY — target binding, first-known seal, history-safe replay

A repair of the §5I/§5J record families, reproduced RED on the untouched 32434e8 runtime with the
review's synthetic probe (in-memory journal, no provider data) before any fix. Source rows, their
identities, the journal duplicate law, writer epoch, schema, providers, MISSION, pump doctrine,
retention firewalls, and trading authority are unchanged.

**Two bindings, one discipline (`rumor2/social-settle.js`).** A correction/conflict record has a
SEMANTIC identity (`sourceEventId`) and, from record version 2, an immutable FIRST-KNOWN SNAPSHOT
(`snapshotHash`). The semantic identity says WHICH correction / conflict / asserted association this
is and dedupes redelivery keep-first (no `Date.now()` in identities; a repeated delivery is not new
evidence). The snapshot is a locally re-derived hash over EVERY field the settled record states —
its first-known clocks (`knownAtTs`, `ts`, `evidenceRetrievedTs`, `candidate.retrievedTs`), target
membership, matching basis, witnesses — so an altered payload that keeps its prior binding is
refused by the validator and by replay. A redelivered record with different clocks would be an
altered payload under an existing journal identity; reconciliation therefore never presents it
(keep-first). Honest scope: the seal detects altered payloads that retain their binding and
enforces internal consistency; it is NOT a signature, NOT an external timestamp attestation, and
proves nothing against an adversary who rewrites authoritative history and every hash together.

**Version-2 pending identity binds the target set.** `RUMOR2_SOCIAL_RECONCILIATION_PENDING`
version 2 adds `candidateTotal` and `snapshotHash`; its identity binds provider, native key,
immutable digest, witness hash, reason, the canonical bounded `candidateIds`, and
`candidateTotal`. A substituted, erased, or over-filled target set can never keep an existing
identity. A grown candidate set (a second potential occurrence learned later) is a NEW later
association record with its own knownAt — the earlier record is never rewritten, an earlier as-of
view never sees the later set, no native events are merged, and logical source counts do not grow.
An unchanged set is keep-first. A bounded list never claims completeness: `candidateTotal >
candidateIds.length` reports truncation at the cap. The intake forgets a version that settled as
unresolved so a later redelivery reaches settlement again (settlement still dedupes an unchanged
association); the local cache never suppresses a justified later association.

**The ONE target-context / reason law (`socialPendingLinkError`, `validateSocialPendingContext`).**
A record's `candidateIds` are asserted relationships, verified against the ACTUAL already-durable
targets and their preserved facts, per reason: DECLARATION_CONFLICT — exactly one target, the same
native occurrence, equal immutable facts, and a declaration the target actually RETAINED (a v2
source witness or an earlier valid SOURCE_DECLARATION annotation; a legacy numeric clock is not
one) that genuinely disagrees under the same comparison law; IMMUTABLE_FACT_CONFLICT — one target,
the same native occurrence, immutable facts that DIFFER; OCCURRENCE_IDENTITY_INSUFFICIENT — every
target shares the documented coarse key and at least one side lacks its sequence (or the candidate
is a Farcaster recast edge), never a merge; MULTIPLE_CANDIDATES — at least two targets, each the
same native occurrence. A target id alone is never evidence; a causally later target, a cross-
provider target, or an unknown id fails the link. Call sites: the reconciler self-checks every
record it emits (durable index + this batch's new sources), replay checks every record before it
may be applied to any target, and the standalone temporal view checks the record's relation to the
event it is asked about. The view is not a weaker back door: a caller-supplied object saying
DECLARATION_CONFLICT proves nothing; with insufficient or inconsistent context the view returns
`ok:false` with the precise reason rather than guessing.

**History compatibility — no silent reinterpretation.** Version-1 (unsealed) annotation and pending
records written before this closeout stay byte-identical and are validated under their own
contract: no snapshot, no set-binding identity. Replay applies a version-1 pending record only when
its links hold against actual history; a version-1 record whose links cannot be verified is retained
as an unlinked unresolved observation (`pendingUnlinked`, with the reason) and never applied to any
target. A version-2 record whose links do not hold is corruption and fails the history closed.
Nothing is manufactured for old rows — no snapshot, no observation time, no matching proof — and a
version-1 record's backdated clocks or substituted targets cannot be detected by the record alone
(stated limit). The view labels `effective.clockIntegrity` as `ORIGINAL_ONLY`, `SEALED` (every
applied record is version 2), or `LEGACY_UNSEALED` (a version-1 record applied under its contract),
so legacy claims are never promoted to sealed truth. A candidate redelivery of a conflict already
retained by a version-1 record over the same target set is keep-first (no sealed twin). Predecessor
fixtures: `test/fixtures/social-4d-legacy-32434e8-records.json`, produced by the untouched 32434e8
runtime, never regenerated.

**INDEX_DIVERGENCE — the existing limitation, kept honest.** A journal-held id unknown to the
hydrated index makes settlement refuse with `INDEX_DIVERGENCE`: nothing appends, no cursor, meter,
or progress adopts, the drained envelopes stay owed in the runtime, and the collector logs and
retries each tick without advancing. There is NO automatic recovery. The supported sequence is
manual: stop the ear (the paid X connection closes; intake bounds and backpressure limit further
work), re-hydrate from the validated authoritative journal (a process restart does this), then
settle — the owed candidates reconcile exactly once (keep-first for the known one, the genuinely
new one appends). Bluesky: cursor obligations and resume cursor are preserved. X: the durable meter,
ruleset epoch, and smoke-run state restore from the journal; the stale process's deliveries metered
locally but never persisted are NOT recovered locally — server project usage re-read at preflight is
the spend authority (existing COST law). This is an operational limitation, not a cosmetic one.

## 5L. SOCIAL-4D UNRESOLVED-CACHE + CAUSAL-CONTEXT CLOSEOUT

Two control-flow repairs of §5K, reproduced RED on the untouched d6692ec runtime with the review's
probe before any fix. No schema, identity recipe, persistence, provider, or authority change.

**KNOWN SOURCE and KNOWN UNRESOLVED are different dispositions
(`rumor2/social-runtime.js`, `rumor2/x-runtime.js`).** The reconciler marks a candidate whose
unchanged association is already retained as `KNOWN … unresolved:true`. Both runtimes carry that
explicit disposition on the envelope and, after SUCCESSFUL terminal handling — a non-empty durable
append or a zero-event batch alike — forget the version in the local cache, exactly as they do for
a newly appended PENDING record. A failed lookup or a refused append installs no terminal cache
disposition. An unresolved observation therefore always reaches the authoritative reconciler on
redelivery: an unchanged association stays keep-first there (no duplicate records), and a grown
candidate set becomes a new later association record. Exactly equivalent real sources keep the
efficient durable-duplicate path; source counts never grow from pending records.

**Causal-context law (`socialPendingLinkError`).** A pending record's asserted reason is judged
with target facts available no later than that record's own knownAtTs: only retained
SOURCE_DECLARATION annotations of the exact target with `knownAtTs <= pending.knownAtTs` (equality
admissible under the millisecond clock contract) or the target's own v2 witness can supply its
basis; a legacy numeric clock and provider-event annotations never do. A later matching annotation
neither justifies an earlier conflict nor retroactively invalidates one, so for a valid history H,
appending otherwise-valid records known strictly after t never changes the success or effective
result of a view of H at t. Integrity validation of those later records is unchanged and separate
from as-of selection. A valid conflict stays a historical conflict at its own time; there is no
resolution semantics and no latest-wins. The law is applied unchanged at reconciliation, replay,
and the standalone view. Legacy version-1 records keep their bytes and honest labels; a legacy
pending record whose only possible basis was known after it is retained unlinked, never applied.

## 5M. SOCIAL-4D EQUAL-CLOCK CAUSAL CONTEXT CLOSEOUT

One boundary of §5L, reproduced RED on the untouched 065d7f8 runtime with the review's probe: an
annotation appended AFTER a pending record but sharing its millisecond knownAt was admitted as that
record's invalidator, so the full-history view refused an accepted history at every query time
(including before the source was known) while the prefix view answered. Millisecond equality is not
proof of causal position.

**The precedence contract (`socialCausalPrecedes`, `socialPrefixPrecedes`).** Whether an annotation
was AVAILABLE to a pending record is decided by knowledge time first and, for the same recorded
millisecond, by the SETTLED JOURNAL ORDER — never by array presentation order, id or hash text,
source or provider clocks, or an invented extra millisecond. A strictly earlier annotation precedes;
a strictly later one does not; an equal-clock annotation precedes only when it settled first. An
annotation whose precedence cannot be established (equal clock, no settled order) is admitted
NEITHER as a conflict's basis (a later annotation cannot retrospectively supply the only missing
basis) NOR as its invalidator (a conflict established by the accepted causal prefix is never
retroactively invalidated). The equality-inclusive policy of §5L stands: an equal-clock basis that
settled before the record remains usable.

**Call sites, one contract.** `replaySocialHistory` exports `settledOrder` (sourceEventId → journal
position over sources, annotations, and pending records) and, being a causal-prefix reader, judges
each pending record with `socialPrefixPrecedes` (knowledge time, equality inclusive) over the
annotations already replayed. The reconciler judges its own emitted record over durable plus
earlier-in-batch annotations the same way. The standalone view accepts `settledOrder`; SUPPORTED
CANONICAL USAGE passes replay's order, and then the view and replay judge the same context for the
same accepted history. Without it the view is exact for unequal clocks; for an equal-clock tie it
returns the specific context-required refusal only when that tie would be the record's ONLY basis,
and otherwise leaves an established conflict undisturbed. No persisted field, identity, or schema
changed; legacy version-1 records keep their bytes and their LEGACY_UNSEALED label. A retained
later annotation equal to the disputed declaration is shown among the retained declarations at and
after its own time; the dispute stays unresolved — there is still no resolution authority here.

## 5N. SOCIAL-4D CONSOLIDATED CAUSAL-ORDER CLOSEOUT — final causal availability and first-known selection

Two defects of §5M reproduced RED on the untouched d24295e runtime with the review's probe: an
annotation settled AFTER a pending record but carrying an EARLIER recorded clock was admitted as
that record's invalidator (the canonical full-history view then refused an accepted history), and
first-known selection among annotations tied at one millisecond fell back to lexicographic record
ids. Both are closed by one contract.

**Causal availability (`socialCausalPrecedes`, `socialPrefixPrecedes`).** An annotation is available
to a pending record as its basis or invalidator only when BOTH hold: (1) knowledge-time
admissibility — its knownAtTs is no later than the record's (equality inclusive); and (2)
membership of the record's PRECEDING SETTLED CONTEXT — it settled before the record in the journal.
With the canonical settled order both are checked for earlier, equal, and later clocks alike; a
later append can never retroactively supply or invalidate the reason for an earlier conflict merely
because it carries an earlier or equal clock. A verified prefix reader (replay, the reconciler's
batch self-check) establishes (2) from the actual prefix; an arbitrary full-list caller may not
claim it by assumption, so without settled positions for BOTH records availability is unknown and
the annotation is admitted neither as basis nor as invalidator. Keep-first is unchanged: a
declaration already retained for a target is never re-recorded whatever its recorded clock.

**First-known selection (`rumor2/social-view.js`).** The applied SOURCE_DECLARATION record (among
equivalent declarations) and the applied PROVIDER_EVENT record are chosen by knowledge time and
then by settled journal position. Ids and hashes never select; a tie that the supplied context
cannot break is a context-required refusal. The moment a disagreement became known is an
order-independent quantity: the first instant two non-equivalent declarations were both known.
Sorted id lists in results are display only.

**Standalone context.** `settledOrder` is the Map exported by `replaySocialHistory`; nothing is
sorted into an invented order, the caller's map and records are never mutated, and a malformed
order is refused rather than falling back to clock, id, or array order. Supported canonical usage is
`socialCanonicalTemporalView({ replay, sourceEventId, asOfTs })`. Simple views (no pending records,
a v2 target's own witness as basis, untied first-known) need no order. The full/prefix answers are
identical wherever the omitted records are inadmissible to the query; later evidence may add
conflict metadata but never a winning source time.

**Compatibility and limits.** No persisted field, identity, schema, or fixture changed; version-1
records keep their bytes and LEGACY_UNSEALED label. The neighbour matrix (settled before/after ×
clock before/equal/after × equivalent/conflicting/precision × sealed/legacy × forward/reversed
input) and a seeded generated set are covered in `test/social-4d-causal-order.test.js`; they are
bounded checks, not an exhaustive proof. INDEX_DIVERGENCE stays a manual re-hydration limit; the
snapshot seal remains self-consistency, not authentication; no conflict-resolution authority exists.

## 5O. SOCIAL-4D STANDALONE ORDER-CONTEXT VALIDATION

A bounded repair of the §5N standalone boundary; the complete replay-derived context was already
correct and is unchanged. Two reproductions on the untouched 6feb28f runtime: an incomplete
three-member tied group selected a record in one input permutation and refused in another (only the
first two sorted entries were checked), and a malformed order giving two distinct records the same
position let the caller's array order pick the applied record.

**Complete tied-group law (`rumor2/social-view.js`).** For each clock role the applied record is the
earliest-known one. When the DISTINCT records sharing that earliest knownAt millisecond number more
than one, the actual settled order decides and EVERY member of that tied group must carry a valid
position; otherwise the selection is refused in every input permutation and no member is silently
discarded. A unique earliest record stays answerable with no order at all, whatever later-known or
unrelated records lack positions; views with no annotations, a single record, or a genuine
declaration conflict likewise need no order. Ids, hashes, caller list order and guessed positions
never decide.

**Malformed-order law (`socialSettledOrderError`, `rumor2/social-settle.js`).** A supplied order is
a context, never an authority: every position must be a safe non-negative integer, no two distinct
ids may claim the same settled position, and the id-list form may not repeat an id as a competing
settlement entry. Holes remain legitimate — the canonical order also carries unrelated sources, and
a subset Map is valid. A malformed order is refused with a specific invalid-order result and never
falls back to timestamp, id, or array order. Internal consistency is all this establishes: a
coherent but fabricated map is not thereby authenticated, and canonical usage remains
`socialCanonicalTemporalView` over a validated replay.

**Duplicate input.** Byte-identical repeats of one record collapse to that one record and create no
extra rank contender; a repeated id whose payload differs is refused as contradictory input. A
record's identity does not bind its knownAtTs, so the same semantic annotation re-created with a
different clock is that same record with an altered payload, never a second contender.

Unchanged: the causal-prefix law, first-known policy for unequal clocks, base-event and annotation
as-of cutoffs, UNRESOLVED_CONFLICT semantics, LEGACY_UNSEALED labels, retention blocks, source
counts, identities, journal semantics, and every runtime path.

## 5P. SOCIAL-4E — remaining social-source foundations (Meta / TikTok / Farcaster access), non-live

**Status: FOUNDATION BUNDLE COMPLETE, NOT LIVE.** Foundation complete is NOT operational access,
account entitlement, production enablement, or a measured trading edge. Nothing here performs a
provider request, authenticated preflight, OAuth exchange, WebSocket, webhook, subscription, login,
purchase, or application; nothing reads or prints a credential value; no runtime, collector,
registry, provider, or persistence module imports a 4E module (pinned by `test/social-4e-foundation.test.js`).

**Documentation check (first-party pages read 2026-09-07; a fetch failure is
`DOCUMENTATION_UNVERIFIED`, never a guess).** Verified: M1 Page Public Content Access (App Review +
Business Verification + possible contracts; `/page/feed`, `/page-post`, `/page-post/comments`;
"Analyze and/or display posts and engagement on Pages"); M2 Page Public Metadata Access (metadata
only; excludes feed/comments); M3 Instagram overview (two login paths; hashtag search only via
Facebook Login under Instagram Public Content Access; App Review for Advanced Access; 4800 ×
impressions / 24 h); M4 Instagram Login (own professional account; no ads/tagging; no hashtag
search documented); M5 Instagram with Facebook Login (professional accounts only; cursor
pagination); M6 Page `/feed` (Post `id` = `{page-id}_{post-identifier}`, `message`, `created_time`,
`permalink_url`, `from{name,id}`; ~600 ranked posts/year; `limit` ≤ 100); Comment reference (`id`,
`parent`, `comment_count`, `like_count` — `message`, `created_time`, `from` were NOT documented on
the pages read, so the comment preview does not parse them); IG Media reference (`id`, `media_type`,
`timestamp` "ISO 8601-formatted creation date in UTC", `permalink`, `username`, `owner`, counts;
`caption` and `media_product_type` documented for Facebook Login only); M7 Meta Content Library
(academic / not-for-profit affiliation reviewed by CASD; controlled environments); M8 Platform Terms
(3.d deletion obligations; 3.a prohibited uses; no explicit automated-financial-use statement); T1
Research API FAQ (commercial users ineligible; 48 h search indexing; up to 10 days metric refresh;
daily quota); T2 Display API overview and the Display Video Object (`id` string, `create_time`
int64 "UTC Unix epoch (in seconds)", counts int32/int64); T3 Research Tools eligibility; Research
query-videos object (`id` int64, `create_time` seconds, `username`, `region_code`, counts,
`hashtag_names`); T4 Commercial Content API (ads/advertiser/commercial content; EU data in this
phase; no content schema verified). N1 Neynar rate limits (Free 600 RPM / 10 RPS per endpoint;
cast search 120 RPM; global 1000 RPM; per subscription plan, independent of credits); N2
search-casts (`q`, `limit` ≤ 100, `cursor`, chronological sort; NO freshness or completeness
statement). **Unverified:** N3 pricing (client-rendered shell on read) and N4 terms (HTTP 404 at
`/terms` and `/terms-of-service`, one recheck each) — consistent with the registry's
`termsRetrieval: FAILED_2026-09-06`. A retrieval limit is not an access decision.

**Shared primitive (`rumor2/social-foundation.js`).** One small pure module, importing only the
sealed temporal boundary, holds what three new modules would otherwise triplicate: the supported
caller clock, the closed record vocabularies (statuses, approval states, agreement states,
retention states, permitted uses, documentation statuses, implementation stages), the sealed
`accessDate` judgement of `reviewedOn` / `validUntil`, the scope/route-bound approval outcome, the
extra-agreement and retention blockers, ONE readiness derivation (every prerequisite AND zero
blockers), and the frozen no-live facts every output spreads in: `liveStatus DISABLED`,
`liveAllowed false`, `liveReason FOUNDATION_ONLY_NO_LIVE_PATH`, `durableContentAllowed false`,
`durableAuthorIdentityAllowed false`, `measuredLatency UNKNOWN`, `productionObservation UNOBSERVED`.
The Reddit and StockTwits foundations keep their own byte-identical copies (pinned).

**Meta (`rumor2/social-meta.js`).** ONE registry provider (`META_PUBLIC`), TWO route namespaces
(`FACEBOOK`, `INSTAGRAM`) that are not checkpoint providers. Ten distinct descriptors —
`FACEBOOK_PAGE_PUBLIC_CONTENT`, `FACEBOOK_PAGE_PUBLIC_METADATA`, `FACEBOOK_MANAGED_PAGES`,
`FACEBOOK_CONTENT_LIBRARY`, `FACEBOOK_AD_LIBRARY`, `FACEBOOK_GROUPS` (no sanctioned route),
`INSTAGRAM_LOGIN`, `INSTAGRAM_FACEBOOK_LOGIN`, `INSTAGRAM_HASHTAG_DISCOVERY` (30 unique hashtags /
7 days), `INSTAGRAM_CONTENT_LIBRARY` — each answering separately: platform path; payload scope;
eligibility requirements (closed prerequisite vocabulary); eligibility established for this
operator (`NOT_ESTABLISHED`); approval/entitlement; credential configuration (env NAMES only;
the Instagram Login route names its own token); permitted uses; extra-agreement applicability
and satisfaction; retention for content and for identity (both `UNRESOLVED_ROUTE_SPECIFIC…`);
implementation stage; measured latency; production observation. Evidence classes keep metadata,
promotion data, operator-managed Pages, and research archives distinct from `PUBLIC_PAGE_ORGANIC`.
An operator record is bound to ONE route (`APPROVAL_ROUTE_MISMATCH` elsewhere) and is
`OPERATOR_ATTESTED` evidence, never platform proof. Previews (`metaPayloadToPreview`) are typed by
route and content kind: Page post (documented string id + namespace; `from.id` contradicting the
id prefix is refused; basic-format offsets such as `+0000` are NOT repaired — recorded `MALFORMED`
with the declaration preserved and no instant), Page comment (id, parent, counts only; text/clock
`DOCUMENTATION_UNVERIFIED`; relationship needs explicit post context; self-parent refused),
Instagram media (caption only where documented for the route; `AD` product type relabelled
`PROMOTION_DATA`; `username` never identity; hidden likes unknown). Missing content is never
deletion. Every preview says `fixtureOnly true, durable false, authority NONE, readinessToken false`
and is rejected by normalization, event build, and settlement.

**TikTok (`rumor2/social-tiktok.js`).** The registry decision is preserved verbatim
(`INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED`, `OPERATOR_REVIEW_PENDING`; no
application made or denied; no permanent exclusion approved). Three product descriptors equal to
the registry route keys: `RESEARCH` (institutional affiliation, non-commercial basis, ethics
review, project approval; route-specific 48 h indexing / 10-day metric refresh), `DISPLAY` (own
videos only), `COMMERCIAL_CONTENT` (commercial dataset; preview
`PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED`). Products cannot impersonate each other; a client
key is configuration and never supplies affiliation or approval. The preview parses documented
epoch SECONDS only as seconds with a range window (`UNSUPPORTED_RANGE` for millisecond magnitudes,
never divided; strings `TYPE_MISMATCH`; floats `NOT_AN_INTEGER`), preserves int64 ids as digit
strings (unsafe numbers refused as `ID_PRECISION_LOST`), derives NO author identity from
`username` / `display_name` / `nickname`, records metrics as a first-known diagnostic snapshot
with `asOf UNKNOWN`, and keeps four distinct clocks (source-created, indexed, metric-updated,
retrieved) each honestly unknown when not supplied.

**Farcaster access boundary (`rumor2/social-farcaster-access.js`).** `providers/farcaster-official.js`
stays byte-identical (sha pinned); the boundary reuses only its key-presence boolean. It separates:
published plan/reference limits (`NEYNAR_PUBLISHED_REFERENCE`, labelled
`PUBLISHED_REFERENCE_NOT_ACCOUNT_ENTITLEMENT`) from this account's plan and credits (`UNKNOWN`
unless attested; account limits `UNVERIFIED`); key presence (`CONFIGURATION_ONLY`) from
entitlement; the suggested acquisition path (`SEARCH_POLLING`, a proposal) from an approved choice;
documented cursor pagination from complete coverage (`UNPROVEN`); unmeasured lag from a real-time
lead (`UNPROVEN`); documented webhook authentication from delivery completeness, ordering, and
replay (`UNPROVEN`). Blockers are independent (`KEY_MISSING`, `PLAN_UNKNOWN`, `CREDITS_UNKNOWN` /
`CREDITS_EXHAUSTED`, `TERMS_UNRESOLVED` / `TERMS_PROHIBIT_USE`, `ACQUISITION_PATH_NOT_APPROVED`,
clock / expiry / agreement / retention). No transport, poller, webhook receiver, collector, or
journal wiring exists.

**Registry.** `META_PUBLIC`, `TIKTOK_PUBLIC`, and `FARCASTER_OFFICIAL` carry explicit `foundation`
metadata (ticket, stage, module, fixtureOnly, live false, durable false, operationalAccess false,
docs accessed 2026-09-07, unverified docs) while `implemented` / `durable` keep their meanings.
The stale "checkpoint v5 migration" wording is corrected: this checkout retains checkpoint v4 and
the Social resume position lives in journal `RUMOR2_SOCIAL_CURSOR` events. The registry imports
none of the 4E modules.

**Stage gates (all pinned).** Stage 1: no evidence leaks across routes/namespaces; metadata / ad /
managed / archive results never labelled organic; malformed relationship / id / clock cannot
fabricate provenance; permissive inputs cannot enable a request or a durable event. Stage 2:
products cannot impersonate; a token cannot supply affiliation or approval; missing clocks /
metrics stay unknown; no raw content reaches a persistent path; bad types, timezone strings, long
ids, partial payloads, absent dates handled. Stage 3: key / Free plan / unrelated approval /
credits cannot authorize; independent blockers; no new runtime imports. Stage 4: zero-capability
imports proven with injected traps (fetch, WebSocket, EventSource, timers, `Date.now`, `new Date()`,
`Math.random`, credential-named `process.env` reads) plus static checks; cross-provider mutation
matrix (the strongest record any foundation accepts readies nothing else, including the Reddit
and StockTwits evaluators); previews incompatible with every source-event envelope; the
Reddit/StockTwits retention firewall unchanged; protected surfaces byte-identical; pump doctrine
preserved; ONE coverage matrix (14 routes: 7 previewable, 3 documentation-unverified, 1 no-route,
3 descriptor-only/boundary).

**Coverage matrix.**

| Provider | Route | Descriptor | Readiness | Preview | Stage |
|---|---|---|---|---|---|
| META_PUBLIC | FACEBOOK_PAGE_PUBLIC_CONTENT | yes | yes | SUPPORTED (post, comment) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| META_PUBLIC | FACEBOOK_PAGE_PUBLIC_METADATA | yes | yes | PREVIEW_UNSUPPORTED_METADATA_ONLY | DESCRIPTOR_ONLY |
| META_PUBLIC | FACEBOOK_MANAGED_PAGES | yes | yes | SUPPORTED (post, comment; OPERATOR_MANAGED) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| META_PUBLIC | FACEBOOK_CONTENT_LIBRARY | yes | yes | PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED | DESCRIPTOR_ONLY |
| META_PUBLIC | FACEBOOK_AD_LIBRARY | yes | yes | PREVIEW_UNSUPPORTED_NOT_ORGANIC_CONTENT | DESCRIPTOR_ONLY |
| META_PUBLIC | FACEBOOK_GROUPS | yes | never ready | PREVIEW_UNSUPPORTED_NO_ROUTE | NO_SANCTIONED_ROUTE |
| META_PUBLIC | INSTAGRAM_LOGIN | yes | yes | SUPPORTED (media; caption not documented for route) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| META_PUBLIC | INSTAGRAM_FACEBOOK_LOGIN | yes | yes | SUPPORTED (media) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| META_PUBLIC | INSTAGRAM_HASHTAG_DISCOVERY | yes | yes | SUPPORTED (media; capped) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| META_PUBLIC | INSTAGRAM_CONTENT_LIBRARY | yes | yes | PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED | DESCRIPTOR_ONLY |
| TIKTOK_PUBLIC | RESEARCH | yes | yes | SUPPORTED (video) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| TIKTOK_PUBLIC | DISPLAY | yes | yes | SUPPORTED (video) | DESCRIPTOR_AND_FIXTURE_PREVIEW |
| TIKTOK_PUBLIC | COMMERCIAL_CONTENT | yes | yes | PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED | DESCRIPTOR_ONLY |
| FARCASTER_OFFICIAL | NEYNAR_HOSTED_API | yes | yes | mapper exists in the provider adapter (unchanged) | ACCESS_BOUNDARY_ONLY |

**Remaining work (SOCIAL-4E) — none of it assumed:** a Meta-specific clock grammar for the
basic-format offset (`+0000`) once an observed payload confirms it (today: `MALFORMED`, declaration
preserved); Comment `message` / `created_time` / `from` and the Commercial Content schema once
documented on a page that can be read; Neynar pricing and terms (retrieval failed twice) — permitted
use, retention/deletion, and prohibited uses remain unverified; every readiness prerequisite is an
operator attestation awaiting the platform's actual decision (App Review, Business Verification,
partner affiliation, TikTok project approval, Neynar plan/credits/entitlement); route-specific
retention and deletion designs before any durable content or author identity; measured latency
and coverage under a real acquisition path; an operator decision on the TikTok current decision
(`OPERATOR_REVIEW_PENDING`) and on the Farcaster acquisition path; a possible consolidation of the
Reddit/StockTwits copies onto the shared primitive (deliberately not done here). Observation (out of
scope): the registry's `implemented` flag means "fixture-only preview adapter" for Reddit/StockTwits
(`true`) but was left `false` for Meta/TikTok per this ticket; the `foundation` metadata now records
the stage explicitly so the flag's two readings are visible.

---

## 5Q. SOCIAL-4F — universe-scope correction: broad discovery, bounded Social investigation

**The defect (reproduced at 9c17372, no provider calls).** `rumor2/collector.js` built ONE registry
from `config.universe` (BTC, ETH, SOL, XRP, DOGE) and used its tickers/aliases for BOTH the Bluesky
local filter and the X rule-manifest anchors: `$BTC` matched, `$LINK` and a synthetic `$FRESH42`
did not, and the compiled default X manifest carried two rules and no LINK. The five configured
majors had become the accidental outer boundary of all Social discovery. Meanwhile
`survey/wideeye.js` already surveyed the full online Kraken USD universe (no volume floor) and kept
its `keyToCoin` map private.

**Five scopes, stated separately (the vocabulary this section uses throughout):**

| Term | Meaning | Owner | Changed here |
|---|---|---|---|
| DISCOVERY_CATALOG | markets current venue evidence lets us observe/research — not eligibility, not authorization, not profitability | `survey/catalog.js` (normalization) via the wide eye's existing AssetPairs acquisition; RUMOR re-validates | NEW |
| SOCIAL_ADMISSION_SCOPE | what an already-authorized local Social ear admits, under a recorded catalog/filter policy | `rumor2/social-scope.js`, activated durably by `rumor2/social-runtime.js` | NEW (replaces the five-coin filter) |
| PAID_WATCH_PLAN | a bounded subset PROPOSED for expensive research; never a subscription, spend permission, or attention state | `rumor2/social-watch-plan.js` | NEW (observation-only) |
| DEEP_OBSERVATION_SET | the capped tape/book subscriptions (volume floor, cap 30, major preference) | `tape/universe.js` | UNCHANGED (byte-identical) |
| LEGACY_PERMISSION_SET | `config.universe` consumers in cost/ledger/official-claim registry/UI/RUMINT/childhood | `cost/model.js`, `ledger/ledger.js`, `rumor2/truth.js` … | UNCHANGED (retained, labelled; widening needs its own ticket) |

**Occurrence census of `config.universe` (Stage A).** Broad-discovery restriction (REPLACED):
`rumor2/collector.js` Bluesky filter + X manifest anchors. Deep-observation allocation (PRESERVED):
`tape/universe.js` selection/fallback, `tape/run.js`, `gateway/collector.js`, `childhood/build.js`.
Execution/cost/ledger permission (PRESERVED, named): `cost/model.js` `evaluateCost` and
`ledger/ledger.js` `recordPrediction` refuse a coin outside `config.universe`. Official claim
resolver (PRESERVED, named): `buildCoinRegistry(config.universe)` in `rumor2/truth.js` still bounds
official-source claim resolution; the collector still builds it for that purpose only. Provider
symbol translation (PRESERVED): `XBT→BTC`, `XDG→DOGE` are the only alias rewrites, now in ONE
shared primitive. Historical/enrichment limitation (PRESERVED honestly): childhood, RUMINT
cadence (`rumint/poller.js` majors set), UI orbit fallback. Benchmarks/fixtures (PRESERVED): test
CONFIG constants still name the five seeds — as an explicitly labelled EXPLICIT_STATIC research
scope, never as an implicit ceiling. Status wording (CLARIFIED): `status.socialResearch` reports the
five scopes separately and states that none of the other four is the discovery count.

**Catalog (Stage B).** `survey/catalog.js` normalizes ONE complete AssetPairs result into a closed,
deep-frozen, deterministically sorted catalog: venue, native pair key, native base/quote, wsname,
canonical research base, quote, observed status, normalization policy version, counts
(observed / supported / excluded / unresolved), typed exclusions (`STATUS_NOT_ONLINE`,
`QUOTE_NOT_USD`, `WSNAME_NOT_USD_SPOT`, `BASE_EXCLUDED_STABLE_OR_FIAT`) and unresolved rows
(`ROW_MALFORMED`, `BASE_UNRESOLVABLE`, `DUPLICATE_COHERENT_ALIAS`). An online USD spot pair that
passes the existing stable/fiat exclusions is in discovery regardless of volume, market cap, sample
count, deep-tape membership, extension/MISSED label, or alias availability; the catalog carries no
volume at all (unknown stays unknown). Coherent alias keys dedupe deterministically; contradictory
native-id / symbol associations REFUSE the candidate (`CONTRADICTORY_NATIVE_MAPPING`,
`CONTRADICTORY_BASE_ASSOCIATION`); empty / non-object / zero-supported / over-bound responses
refuse (`RESPONSE_EMPTY`, `RESPONSE_MALFORMED`, `ZERO_SUPPORTED`, `CATALOG_OVERFLOW` — reported,
never truncated and called complete). Adoption law: a candidate with fewer than half the previously
accepted supported markets is `SUSPECTED_INCOMPLETE`; an acquisition clock behind the accepted one is
`OBSERVED_CLOCK_REGRESSION`; both retain previous truth. Content id = sha1 of the canonical market
rows; `rumor2/social-catalog.js` re-derives it with the rumor helpers (pinned equal).

**Wide-eye seam.** `startWideEye` now returns `{ stop, catalogSnapshot, researchNotices }`. The sweep
map is built through the SAME per-row primitive (`krakenUsdSpotBase`) as the catalog, so alias
compatibility is one code path; the sweep cadence and backoff are unchanged. Metadata refresh runs on
the existing sweep tick — never a second poller, never one request per coin — no more often than
`socialResearch.catalog.refreshSec` (≥ 300 s, attempt-based), with maximum age 900 s and a hard bound
of 5,000 normalized markets; one refresh in flight; `stop()` disowns late results; a failed or refused
refresh keeps previously accepted truth and records `CATALOG_REFRESH_ERROR` / `CATALOG_REFUSED`
(the first-load failure keeps its historical sweep backoff). An ACCEPTED refresh lets a new listing
enter both the catalog and the sweep without a restart, with the ACTUAL acquisition clock (never
backdated, never a provider creation date). The snapshot is deep-frozen; a stale one is labelled
(`fresh: false`), never relabelled fresh, never dropped. `fly.js` retains the handle and injects
`{ snapshot, notices, deepObservation }` into `startRumor2`; the wide eye disabled ⇒ `null` ⇒ Social
reports `CATALOG_UNAVAILABLE` and never starts it.

**Versioned scope truth (Stage C).** Three CLOSED operational records ride the existing PostgreSQL
RUMOR event root under the existing writer lock/epoch (no new journal, table, epoch, checkpoint
provider, or history rewrite): `RUMOR2_SOCIAL_CATALOG` (content, written only when the content
changes; identity `r2cg-` = venue + content id), `RUMOR2_SOCIAL_CATALOG_VERIFIED` (a small freshness
record when an unchanged refresh advances the acquisition clock; identity `r2cv-` = venue + content
id + observedTs; at most one per refresh), and `RUMOR2_SOCIAL_SCOPE` (one activation occurrence per
provider; identity `r2sq-` = provider + monotonic revision, so a retry is byte-stable and A→B→A is
three occurrences; carries mode, catalog content id + observed clock, policy version, filterId,
term count, static terms (static mode only — catalog-backed terms are content-addressed), alias facts,
watch authors, predecessor revision + filterId, activation clock, reason). Replay validates each
(`filterId` re-derives from the exact scope; revisions are contiguous; a catalog-backed scope must
reference settled catalog content and match its term count; clocks never regress) and exposes
`catalogs`, `scopes`, `scopeHistory`, `catalogVerified`; these records never touch `observed`,
cursors, the version index, independence groups, packets, or velocity. `socialScopeAt(history,
knownAtTs)` is the as-of law: the latest activation at or before the record's knowledge clock;
before the first activation the scope is `LEGACY_SCOPE_UNKNOWN` — old histories are never backfilled
with today's catalog.

**Admission scope + collector integration (Stage D).** The policy (`rumor2/social-scope.js`, v1):
explicit cashtag `$BASE`, hashtag `#BASE` (non-ambiguous only), venue pair `BASE/USD` or `BASE-USD`,
a validated unique alias (the same approved facts as the official resolver, read only), or an
UPPERCASE non-ambiguous bare ticker of ≥ 3 chars WITH a bounded crypto-context term; ambiguous
tickers (a closed list — ONE, GAS, AI, LINK, NEAR …) need a cashtag/pair; lowercase and
context-free bare tickers are `UNRESOLVED` (`AMBIGUOUS_TICKER_REQUIRES_CASHTAG`,
`BARE_TICKER_NO_CONTEXT`); an unknown cashtag is `UNKNOWN_CASHTAG` — research information kept in a
bounded diagnostic ring, never a market, never a request. URLs and @handles are removed first;
tokens are ASCII-only (no Unicode folding: a lookalike never becomes a cashtag); text and token
counts are bounded; no term ever becomes a regex. Admission is a venue-market research candidate,
never confirmation, never the source's intended chain asset. In `EXPLICIT_STATIC` mode the operator's
few explicit terms keep the legacy standalone-token behaviour. The Bluesky runtime consults the
research scope source every settle: no stream opens before an admission scope is DURABLE
(`SCOPE_NOT_ACTIVE`); a scope change is a QUIESCENT transition (hold new intake, durably drain every
owed envelope — prepared/failed batches included — under the OLD scope, append [catalog content if
new, activation] as one fenced batch, then replace the immutable admission context and reconnect
from the durable cursor); on restart the last durable scope is restored from journal truth (its
content must re-derive the same filterId, else WITHHELD) and stale/unavailable catalogs never grant
NEW scope while the restored scope continues, labelled. Lifecycle continuity: an edit/delete/reply/
repost of an already-durable native post is admitted from retained native identity (rebuilt from the
journal on every hydrate, so it survives restart and cache eviction) even without ticker text and
after the asset left the scope; unknown unlinked lifecycle events stay unmatched. Unknown source
time keeps the evidence and establishes nothing (the quarantine/precision witness laws are unchanged).

**Handoff and paid watch (Stage E).** `buildWatchPlan` is observation-only and PROPOSED: inputs are
the accepted catalog and already-known research notices (RIPPLE and MISSED alike — a MISSED label is
context, not a veto) plus optional explicit operator candidates; priority is explicit and bounded
(operator candidate, RIPPLE notice, MISSED notice; then most recent, then |zVol|, then base) with a
default cap of 25 (a stricter operator cap is honored; a looser one never exceeds 25); deferred
assets remain in discovery; no volume-only path, no majors-first, no return target. CRITICAL X
SEPARATION: `rumor2/x-runtime.js` compiles rule anchors ONLY from an explicit bounded watch scope —
`config.socialResearch.xWatch` (mode `EXPLICIT_STATIC`, tickers verified against the accepted catalog,
cap ≤ 25) or a test-injected static list labelled `INJECTED_STATIC`; empty/missing/unverified ⇒
`WATCH_SCOPE_NOT_CONFIGURED` / `WATCH_SCOPE_CATALOG_UNAVAILABLE` / `WATCH_SCOPE_EMPTY_AFTER_VERIFICATION`
/ `WATCH_SCOPE_EXCEEDS_CAP` and ZERO X requests — no five-coin fallback, no full-catalog fallback,
no plan applied. A change of explicit scope reconciles disconnected through the existing dry-run,
owned-rule reconciliation, unowned-rule verification, coverage epoch, budget, writer, and durable
smoke RUN_ID laws (a run bound to another rule-set hash fails closed). The committed config selects
NO paid target (`xWatch.mode: NOT_CONFIGURED`). Every delivered Post is still metered before the
local filter; no cap, connection count, or reserve changed.

**Configuration and status (§7 of the ticket).** ONE new section, `socialResearch`, in
`cobra.config.json` (an intentional hash change; every pre-existing key is deep-equal to 9c17372):
`catalog { source: WIDEEYE_ASSET_PAIRS, refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 }`,
`localAdmission { mode: CATALOG_BACKED, policyVersion: 1, staticTerms: [] }`, `xWatch { mode:
NOT_CONFIGURED, tickers: [], maxAssets: 25 }`, `watchPlan { maxXAssets: 25 }`. Closed types and
modes; an invalid section fails closed to NOT_CONFIGURED with a `CONFIG_INVALID` reason; a missing
section is NOT_CONFIGURED (never a silent fallback); `EXPLICIT_STATIC` requires explicit terms and is
labelled. `status.socialResearch` reports discovery (source, content id, observed clock, freshness,
counts, snapshot errors), local admission (mode, active revision/filterId/term count, coverage
state + reason, restored flag, continuity, unresolved notes), paid watch (PROPOSED plan vs configured
vs verified vs active rule set), deep observation (count, labelled "not the discovery count"), legacy
permission (count, labelled), and the historical-coverage statement (scope known only from durable
scope records; earlier history LEGACY_SCOPE_UNKNOWN; not-watched is never zero mentions).

**Test evidence.** `test/social-4f-catalog.test.js` (normalization integrity, determinism,
adoption law, the wide-eye seam with exact 300 s / 900 s boundaries, one in flight, stop disowns
late results, deep/legacy sets unchanged), `test/social-4f-scope.test.js` (policy matrix incl.
ambiguity, digit-prefixed tickers, URL/handle/substring/Unicode/injection collisions, permutation-
invariant filterId, closed records + replay incl. A→B→A, config closure, config deep-equality vs
9c17372, watch plan determinism/cap, explicit X scope + real compiler, protected-surface pins and
import allowlists), `test/social-4f-runtime.test.js` (no stream before scope, non-major admission,
name-hack proof incl. a catalog without the seeds, the quiescent transition with owed/failed/duplicate/
unknown-time/pending work and the 41/42/dup-42/filtered-43 regression, lifecycle continuity across
restart and eviction, stale/unavailable/future catalogs, A→B→A, restore mismatch, failed activation
and lost fence), `test/social-4f-collector.test.js` (PostgreSQL: the real composition seam with an
injected broad snapshot, durable non-major evidence under a real writer epoch, restart/replay with
correct knownAt and scope, crash/writer-loss/failed-lookup postures, X bounded selection with the
real compiler and fake API, zero-spend cases, config.universe independence, unowned rules preserved,
plan change + coverage epoch + smoke RUN_ID mismatch, status truth and no trade leak), and
`R2A-SOCIAL-8` in the authority suite (explicit allowlists; the rumor tier never imports survey/tape/
cost/ledger; no Social runtime reads `config.universe`).

**Not done, deliberately.** No live exchange or Social request; no paid X call; no smoke; no
production or configuration change beyond the new config section; `config.universe` and its
cost/ledger/official-claim effects untouched; the official claim resolver stays bounded to its
registry (SOCIAL-5 may associate retained evidence with broader research subjects under its own
reviewed contract); childhood/RUMINT history not rewritten; the pump doctrine unchanged; Reddit /
StockTwits / Meta / TikTok / Farcaster access and retention firewalls unchanged; no autonomous
unknown-asset investigation (unresolved cashtags are a bounded diagnostic ring — a research-request
authority interface is explicitly deferred); Bluesky live activation itself still requires the
existing gate and a running wide eye for catalog coverage.

### 5Q-R. SOCIAL-4F operational scope closeout — eight repaired laws

An independent review of 930ef32 reproduced eight synthetic correctness failures in the 4F
integration (none a deployment incident). Each is now a permanent regression
(`test/social-4f-closeout.test.js`, RED on 930ef32) and a stated law:

- **ONE verified X watch snapshot at ACTUAL activation (A).** The X runtime's upstream rule
  manifest, local admission filter, coverage identity, and status derive from the SAME immutable
  watch snapshot adopted when the paid stream is actually activated (`status().activeWatch`) —
  never from a construction-time null/stale resolution. A catalog that arrives after boot therefore
  admits the selected non-major through the real runtime -> intake -> journal path. An approved
  watch change reaches an ACTIVE runtime as a DISCONNECTED transition: the transport closes, owed
  Posts settle under the old snapshot (no reclassification, meter/progress preserved), and the next
  start adopts the new snapshot for rules + filter together in a new coverage epoch. A test-injected
  `filter` is a labelled override; positive tests use the default construction.
- **Owed-native lifecycle continuity (B).** An admitted, validated CREATE that is enqueued but not
  yet durable is an intake OBLIGATION. Its immediately following delete / reply / repost is admitted
  from that TEMPORARY interest (owned by the owed envelope, released when it settles or clears;
  `continuity.owedNativePosts`) for normal validation and settlement. Temporary interest never mints
  source truth, an author, or a parent; it derives only from validated admitted observations; it
  does not survive a restart — the redelivered original re-establishes it. Durable interest (journal
  truth) stays separate (`lifecycle-continuity` vs `lifecycle-continuity-owed`).
- **Prepared scope operations (C).** A catalog / verification / scope-activation batch is prepared
  ONCE (immutable content, revision, predecessor binding, recorded clock) and RETAINED until its
  append succeeds (`scope.pendingOperation`). A retry after a refused or lost acknowledgement is
  byte-identical, so the journal collapses a committed-but-unacknowledged operation instead of
  refusing it as corruption. A changed candidate never overwrites an owed operation; it becomes a
  bounded following revision with its own honest clock. Order: validate candidate -> drain owed
  old-scope work through the existing prepared-batch law -> retain the exact batch -> fence check ->
  epoch-guarded append -> fence RE-CHECK -> adopt / replace filter / reopen.
- **Writer loss during a scope append (D).** A fence lost after a successful append leaves valid
  journal-ahead truth (`scope.journalAhead`); this runtime adopts nothing, opens no socket, and
  reports STANDBY. The lawful writer hydrates the committed operation from the journal exactly once.
- **Complete commit receipts (E).** Every successful old-scope drain commit is reported to the
  collector (events in journal order, source count, final sequence) — also when the following scope
  append fails (`committed` on a failed result). The collector advances its watermark and feeds the
  best-effort mirror from those receipts under a held fence only; mirror failure never rolls back
  journal truth.
- **Catalog structural semantics (F).** A supported row requires the EXACT `BASE/USD` wsname
  grammar (a suffix check is not a locator: `LINK/OTHER/USD` is excluded, never LINK), a retained
  venue-native base identifier (missing -> UNRESOLVED `NATIVE_ID_MISSING`, never a verified supported
  row), one native asset per research base (contradiction -> refusal), and a display base that
  RE-DERIVES from its wsname under the two approved aliases. The survey normalizer and the Social
  validator pin the same grammar, native-id grammar, and alias map (parity test); a rehashed
  contradictory row is refused by the content validator, the event validator, and replay.
- **Local acquisition clock (G).** The catalog's `observedTs` is our acquisition clock, not a social
  author's client clock: an observation ahead of the evaluation clock is FUTURE with NO tolerance,
  no clamp, no fabricated past observation — at the source, the builders, the validators, replay,
  and the X resolver (which now receives the whole candidate: a catalog attached only diagnostically
  to a STALE / UNAVAILABLE candidate verifies no new paid scope; an already adopted watch continues
  under its snapshot until a stop). Social source-time quarantine and unknown-time retention are
  unchanged.
- **Complete token boundaries (H).** A token is delimited only by whitespace (any script),
  punctuation, symbols, separators, and controls. A lookalike letter, combining mark, Unicode digit,
  or invisible format character ATTACHED to a token keeps the whole token unestablished — it is
  dropped whole, never split into a manufactured exact match. Multilingual prose, Unicode
  punctuation, emoji, digit-prefixed tickers, and any-case URL schemes behave. (Consequence: an
  invisible character glued to a cashtag no longer matches; SCOPE-2 was tightened accordingly.)
- **Receipt / scope association contract.** The scope that governed a durable source is the
  provider's latest activation preceding the source IN JOURNAL ORDER (`replay.observedScope`). A
  source drained under the old scope and the new activation may share one knowledge millisecond;
  journal order — never an invented millisecond or a lexical id — keeps them apart. The clock-only
  as-of law (`socialScopeAt`) is an upper bound at that shared millisecond, disclosed as such.

**Cutover note.** No journal was edited. A previously accepted catalog record that violates the
tightened structural invariants (none exists for real venue rows, which always carry a native
base) makes that Social history invalid on hydrate — fail closed and reported, never silently
blessed or re-mapped. The X runtime's local second boundary keeps the legacy case-insensitive
token filter (X's own rule engine decides paid matching); the research admission policy above
governs the catalog-backed Bluesky lane.

---

## 6. Authority audit

- Social providerKinds are not claim-capable → `classifyOfficialItem` returns
  `null` → no typed claim, ever.
- The stage estimate is `UNKNOWN`/uncalibrated and never a trade verb.
- No social path to Attention/HYPED/eligibility/score/sizing/execution.

---

## 7. Remaining work before SOCIAL RUMOR can be frozen

SOCIAL-1 is the foundation; it is **not** the frozen social layer. Remaining:

- **SOCIAL-1 completion — DONE in SOCIAL-2A (§5A), current state (SOCIAL-4D):** this
  checkout retains checkpoint **v4**; the Social resume position lives in journal
  `RUMOR2_SOCIAL_CURSOR` events (no v5 migration exists or is required); the Bluesky
  ear is drained inside the single-writer collector tick under `RUMOR2_SOCIAL_BLUESKY_ENABLED`
  (default off); the source-clock quarantine law is sealed (§5B). One real live Bluesky
  smoke informed §5B. Production gate state remains **unobserved** here.
- **SOCIAL-2 — DONE in SOCIAL-2B (§5C–§5E):** X operational collector with the hard cost
  governor, chunk-atomic stop, and the durable paid-smoke run-ID law. The authorized
  **paid X smoke has NOT been performed**; X stays dark without the explicit run ID,
  budget, bearer, and enable gate.
- **SOCIAL-3 (foundation done, §5F):** Reddit remains fixture-only. A separate
  live-activation ticket requires Reddit's actual approval + classification of the
  private single-user personal-trading use, any separate agreement it establishes,
  reviewed retention/deletion compatibility with a compatible durable design, explicit
  downstream-use permissions, an approved rate scope, and credentials — none assumed.
- **SOCIAL-4 (4A review + 4B foundation done, §5G):** StockTwits stays two things — the
  legacy aggregate RUMINT ear (config-enabled, deployment unobserved, route entitlement
  unresolved, unchanged) and a fixture-only, retention-blocked raw Social foundation. A
  route-specific live-activation ticket requires the account's actual entitlement to a
  named route, the applicable offering terms confirming Serpent's permitted use and any
  additional terms, reviewed raw-content/author retention with a compatible durable design,
  explicit downstream-use permissions, rate/pricing scope, credentials, and the
  single-acquisition/two-projection migration proof — none assumed.
- **SOCIAL-4D COMPLETION — DONE (§5I):** the six provider clock paths are wired to the pure
  boundary through bounded temporal witnesses; legacy history is reconciled by ONE native-event
  matcher (annotate or hold, never remint); the as-of view separates what was recorded from what
  is supported now. Not a live rollout: no provider gate, budget, or credential changed. Farcaster
  activation still needs this account's Neynar plan/credits, readable terms, retention/deletion
  answers, an acquisition path (search polling proposed), overlap/gap law, and first-known
  diagnostics — none assumed.
- **SOCIAL-4D CLOSEOUT — DONE (§5J):** cursor obligations owned by envelopes, one equivalence law
  on every duplicate route, missing-discriminator uncertainty, no last-wins corrections, as-of
  base-event admissibility, detached views. A repair, not a rollout; further defects may exist.
- **SOCIAL-4D RECORD INTEGRITY — DONE (§5K):** sealed version-2 correction/conflict records, target-
  set-bound pending identity, one target-context law across settlement/replay/view, legacy
  version-1 records under their own contract, INDEX_DIVERGENCE recovery documented as manual.
  Further defects may exist.
- **SOCIAL-4D UNRESOLVED-CACHE + CAUSAL-CONTEXT — DONE (§5L):** KNOWN-unresolved is released
  from the local cache on every successful settlement; pending records are judged only by context
  known no later than themselves. Further defects may exist.
- **SOCIAL-4D EQUAL-CLOCK CAUSAL CONTEXT — DONE (§5M):** equal-millisecond precedence follows the
  settled journal order; replay exports it and the canonical view consumes it. Further defects may
  exist.
- **SOCIAL-4D CONSOLIDATED CAUSAL-ORDER — DONE (§5N):** availability = knowledge admissibility AND
  settled-prefix membership; first-known selection by settled position, never by id; neighbour
  matrix and seeded checks. Further defects may exist; the Social/RUMOR layer is not complete.
- **SOCIAL-4D STANDALONE ORDER-CONTEXT — DONE (§5O):** the whole earliest tied group must be
  positioned or the selection is refused; malformed orders are refused, never resolved by input
  order. Further defects may exist; the Social/RUMOR layer is not complete.
- **SOCIAL-4E — FOUNDATION BUNDLE COMPLETE, NOT LIVE (§5P):** Meta route descriptors + readiness +
  fixture previews, TikTok product descriptors + readiness + video preview (decision unchanged),
  Farcaster access/readiness boundary (adapter byte-identical), one shared pure primitive. Not
  operational access, not account entitlement, not production enablement, not a measured edge; the
  remaining-work list in §5P stands.
- **SOCIAL-4F — UNIVERSE-SCOPE CORRECTION DONE (§5Q):** Social research is no longer implicitly
  confined to the five legacy config assets; discovery (catalog), local admission (durable versioned
  scope), paid watch (explicit bounded selection; plans PROPOSED only), deep observation, and legacy
  permission are separate and observable. Not a live rollout: no provider activation, paid access,
  historical knowledge, or trading authority was invented. **Operational scope closeout done
  (§5Q-R):** X admission from one adopted watch snapshot, owed-native lifecycle continuity, prepared
  scope operations with fence re-check and complete commit receipts, catalog structural / clock /
  token truth.
- **SOCIAL-5:** cross-platform provenance / propagation / pump-stage engine
  (calibrate the stage classifier against real history).
- **SOCIAL-6:** author reliability / deletion / historical-outcome research.
- **SOCIAL-7:** full combined social hardening + freeze.

Do not call the social layer complete until every intended provider is either
operational-and-tested or explicitly excluded with a current reason, and the
cross-platform provenance/reputation logic exists.
