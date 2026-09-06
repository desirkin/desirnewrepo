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
`…_LIVE_SMOKE_MAX_POST_READS`, `…_PRIORITY_ACCOUNTS`, `…_PROPAGATION_FOCUS`. Missing bearer ⇒
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
