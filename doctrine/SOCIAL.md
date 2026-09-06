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
| **FARCASTER_OFFICIAL** | microblog | `AVAILABLE_REQUIRES_CREDENTIAL` | Neynar hosted API (x-api-key, free tier) gives real-time webhooks + cast search. Hub/Snapchain path needs a full syncing node (not lightweight). Dark until `NEYNAR_API_KEY`. |
| **X_OFFICIAL** | microblog | `AVAILABLE_REQUIRES_CREDENTIAL` | Pay-per-use filtered stream (~4–5s P99), OAuth2 App-Only bearer. Hard read/USD budget under the 3M-post-read/month self-serve cap ($0.005/read; usage via `/2/usage/tweets`; UTC-day dedupe is SOFT). Operational, runtime-gated ear since SOCIAL-2B (§5C). |
| **REDDIT_OFFICIAL** | forum | `AVAILABLE_REQUIRES_APPROVAL_AND_CLASSIFICATION` | Official OAuth2 Data API is a documented path; API data access requires Reddit's explicit approval with honest disclosure. Serpent's private single-user personal-trading use is **UNRESOLVED** (not assumed commercial, not assumed exempt); any separate-agreement requirement and retention compatibility are unresolved. Scraping is prohibited. Fixture-only foundation (SOCIAL-3, §5F) — not an operational ear. |
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
| A. source-declared | `sourceDeclaredTs` | the exact parsed provider-record creation time (Bluesky `record.createdAt`, Farcaster cast timestamp): client-supplied, immutable record content, **not** an authoritative clock |
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
five claim-capable ears; it is classifier-null.

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
- **SOCIAL-3 (foundation done, §5F):** Reddit remains fixture-only. A separate
  live-activation ticket requires Reddit's actual approval + classification of the
  private single-user personal-trading use, any separate agreement it establishes,
  reviewed retention/deletion compatibility with a compatible durable design, explicit
  downstream-use permissions, an approved rate scope, and credentials — none assumed.
- **SOCIAL-4:** StockTwits operational collector **iff** legitimate API access
  becomes available (Firestream), else a formal exclusion/access decision.
- **SOCIAL-5:** cross-platform provenance / propagation / pump-stage engine
  (calibrate the stage classifier against real history).
- **SOCIAL-6:** author reliability / deletion / historical-outcome research.
- **SOCIAL-7:** full combined social hardening + freeze.

Do not call the social layer complete until every intended provider is either
operational-and-tested or explicitly excluded with a current reason, and the
cross-platform provenance/reputation logic exists.
