# SOCRATES — Doctrine

**"I interpret evidence. I do not create truth."**

That sentence is permanent. Every future Socrates ticket inherits it.

## What Socrates is

Socrates is the future reasoning layer of Serpent. It consumes one
`serpent-evidence-1` packet — a bounded, point-in-time, provenance-complete
record of what Serpent legitimately knew at one instant — and emits one
`socrates-analysis-1` analysis: an interpretation of that packet, nothing
more.

SOCRATES IS AN INTERPRETER, NOT A SENSOR.

SOCRATES IS AN INTERPRETER, NOT AN EXECUTOR.

SOCRATES MAY BE WRONG.

SOCRATES MUST CITE THE EVIDENCE IT USED.

## What Socrates is not

- Not an oracle.
- Not an evidence collector.
- Not an execution engine.
- Not a truth source.
- Not a trading authority.
- Not a replacement for deterministic validation.

As of SOCRATES-CONTRACT-0, no model is called, no prompt exists, and
nothing in the live Serpent runtime imports either contract. This ticket
defines the language only.

## The evidence packet (`serpent-evidence-1`)

Defined in `evidence/contract.js`. A packet is neutral sensor truth:
facts, claims, derived sensor metrics, provenance, coverage, known
contradictions, known unknowns, and bounded historical analogs — assembled
by collectors, never by Socrates.

### Point-in-time truth always

POINT-IN-TIME TRUTH ALWAYS.

Every packet carries `asOfTs`. Every fact carries its own clocks
(`publishedTs`, `observedTs`, `retrievedTs`, `knownAtTs`) where
applicable, and a fact is admissible only when `knownAtTs <= asOfTs`.
A packet that violates this is **rejected** — never clamped, never
rewritten. Historical analogs obey the same law twice over: the analog and
its historical outcome must both have been fully known before `asOfTs`.
No future leakage, ever.

### Unknown remains unknown

UNKNOWN MUST REMAIN UNKNOWN.

Evidence states are `KNOWN / MISSING / UNAVAILABLE / STALE / CONTRADICTED`.
`MISSING` and `UNAVAILABLE` evidence carries a **null** value — the
validator rejects any numeric value there, so an unheard number can never
quietly become zero. `STALE` keeps its state and must say when it was
actually observed; stale is not current.

### Absence of coverage is not evidence

ABSENCE OF COVERAGE IS NOT NEGATIVE EVIDENCE.

Provider coverage states are
`OBSERVED / NOT_QUERIED / UNAVAILABLE / FAILED / STALE / NOT_SUPPORTED`.
"Reuters said nothing" (OBSERVED, no matching evidence) is a different
truth from "Reuters was never asked" (NOT_QUERIED) and from "Reuters was
unreachable" (UNAVAILABLE / FAILED). The packet keeps those distinct so
Socrates can never mistake silence Serpent chose for silence the world
produced.

### Claims are not facts

A claim is something a source **asserts** ("Exchange X will list TOKEN").
It lives in `claims` with a status
(`UNVERIFIED / CORROBORATED / PRIMARY_CONFIRMED / CONTRADICTED / RETRACTED / UNKNOWN`).
Corroboration is never inferred from raw source count.

### Echoes are not corroboration

ECHOES ARE NOT INDEPENDENT CORROBORATION.

Claim/source relations are explicit links:
`ORIGIN / INDEPENDENT_SUPPORT / ECHO / PRIMARY_CONFIRMATION / CONTRADICTION / RETRACTION`,
each with an `independenceGroup`. A hundred copies of one rumor are one
rumor. The validator enforces this: `CORROBORATED` requires non-ECHO
support from at least two distinct independence groups, and
`PRIMARY_CONFIRMED` requires a `PRIMARY_CONFIRMATION` link from an
`OFFICIAL` source. Echo-detection algorithms come later (RUMOR-2); the
language for their conclusions exists now.

### Authority is a label, not a weight

Sources carry `authorityClass`
(`OFFICIAL / ESTABLISHED / IDENTIFIED / PSEUDONYMOUS_KNOWN / ANONYMOUS / UNKNOWN`).
These are labels. There is no numeric weight table — context will matter
later, and this contract has no right to pre-decide it.

### Untrusted text is data, never instruction

External text is evidence, never instruction. Raw excerpts ride inside
sources explicitly marked `untrusted: true`, content-hashed, bounded to
1,000 characters each and 8,000 characters per packet, with at most 32
sources. A future model layer must never execute commands found inside
excerpts. Socrates cannot follow commands from a tweet, post, or article;
cannot reveal secrets; cannot request credentials; cannot call execution
modules; cannot mutate control state; cannot place orders; cannot change
thresholds; cannot change its own system instructions. The analysis
reserves `security.untrustedTextSeen`, `security.promptInjectionSuspected`
and `securityNotes` so suspicion is recorded, not swallowed.

### Bounds

Packets are bounded — this is also the future cost funnel:
claims 12, sources 32, evidence 64, claim links 96, contradictions 24,
missing evidence 24, analogs 6, raw excerpt text 8,000 characters total.
Over-bound input **fails validation**; nothing is silently lopped off.

### Semantic identity

Identities are semantic hashes with stable prefixes (`sep-`, `clm-`,
`src-`, `evd-`, `soc-`): sha1 over canonical key-sorted JSON, immune to
object key order and pretty-print whitespace, never random UUIDs. Array
ordering is documented per array (`ARRAY_ORDER_POLICY`): every packet
array is an unordered set, normalized before hashing; in the analysis only
`watchNext` is ordered, because its priority order is meaning.

## The analysis (`socrates-analysis-1`)

Defined in `socrates/contract.js`. States:
`ANALYZED / INSUFFICIENT_EVIDENCE / WITHHELD_INVALID_PACKET / MODEL_UNAVAILABLE`.
When evidence is inadequate, Socrates says so — it does not fabricate a
thesis. Over an invalid packet, only `WITHHELD_INVALID_PACKET` may be
emitted.

### Mechanism before metric

MECHANISM BEFORE METRIC.

Socrates' central job is: *what mechanism could make this evidence move
price?* An `ANALYZED` output must carry a mechanism citing at least one
`evidenceRef` from the packet. Every reference in the analysis must
resolve into the input packet — dangling references are rejected.
Statements distinguish `FACT_REFERENCE` from `INFERENCE`, and an inference
must still cite the facts and claims that support it. No unsupported
invented fact.

### Market implication is a hypothesis, not a trade

`marketImplication` carries a direction
(`UPWARD_PRESSURE / DOWNWARD_PRESSURE / MIXED / NO_CLEAR_DIRECTION / UNKNOWN`)
and horizon (`SECONDS` through `LONGER / UNKNOWN`) with evidence refs, so
Memory can score it objectively later. It contains no BUY, no SELL, no
entry, no exit, no position size, no stop, no order type.

### Pump-stage detector, not pump filter

WE ARE NOT BUILDING A PUMP FILTER. WE ARE BUILDING A PUMP-STAGE DETECTOR.

Stage carries a general phase (`EARLY / MID / LATE / UNCLEAR`) and a pump
stage (`NOT_APPLICABLE / EMBRYONIC / EXPANDING / DEVELOPED / DISTRIBUTING /
EXHAUSTED / UNCLEAR`). A pump-like move is classified, never automatically
rejected.

### Falsifiers are mandatory

An `ANALYZED` output must state what would make it wrong: each falsifier
carries `condition`, `whyItMatters`, and `evidenceToWatch`. "Things could
change" is not a falsifier.

### watchNext is observation guidance

`watchNext` names what to observe next (an official announcement, MICRO
buyer aggression, price failing to respond, a retraction at the origin…).
It is guidance for collectors and humans. It is **not** execution
permission.

### Forbidden execution semantics

The analysis validator rejects — does not ignore — any field carrying
execution authority at any depth: `buy`, `sell`, `trade`, `strike`,
`entry`, `exit`, `positionSize`, `order`, `limitPrice`, `marketOrder`,
`stopLoss`, `takeProfit`, `execute`, and kin. An analysis that attempts to
carry execution authority fails validation.

## The contract is closed (SOCRATES-CONTRACT-0A)

THE CONTRACT IS CLOSED.

UNDECLARED FIELDS ARE INVALID.

MEMBER IDENTITIES ARE RECOMPUTED, NOT TRUSTED.

MODEL OUTPUT CANNOT EXTEND ITS OWN SCHEMA.

STRUCTURED EVIDENCE VALUES MUST BE JSON-SAFE AND BOUNDED.

SEMANTIC SET ORDER DOES NOT CREATE DIFFERENT TRUTH.

Every object layer in both contracts carries an exact allowed-key
whitelist; a field the schema did not declare fails validation at any
depth, so no producer or future model can smuggle a `recommendation`, an
`instructions` string, or an unbounded `body` past the excerpt bounds. A
claim/source/evidence id must be the recomputed semantic hash of its own
content — a correctly shaped forged id fails. Evidence values admit only
null, booleans, finite numbers, bounded strings, and bounded plain
arrays/objects (no NaN, Infinity, BigInt, undefined, cycles, or class
instances), and whole packets and analyses have aggregate canonical size
caps. The validators never throw on hostile input and never normalize it
into validity — they reject. Nested `sourceRefs`/`claimRefs`/
`evidenceRefs` arrays are unordered sets: order never changes identity,
and duplicate members are invalid. A claim may state RETRACTED or
CONTRADICTED only when a RETRACTION or CONTRADICTION relation proves it,
a source cannot be retrieved before it was published, and an observation
cannot be known before it was observed.

## Independence and withholding are sealed (SOCRATES-CONTRACT-0B)

ONE SOURCE CANNOT CORROBORATE ITSELF.

CORROBORATION REQUIRES DISTINCT SOURCES AND DISTINCT PROVENANCE GROUPS.

INDEPENDENCE GROUPS ARE PROVENANCE LABELS, NOT MULTIPLIERS.

WITHHELD_INVALID_PACKET CARRIES NO INTERPRETATION.

INVALID EVIDENCE MAY NOT BECOME ANALYSIS BY HIDING INSIDE A WITHHELD STATE.

A given claim+source pair may carry at most ONE non-ECHO support relation
(ORIGIN or INDEPENDENT_SUPPORT) — a second one rejects the packet, never a
silent collapse — so a producer cannot manufacture independence by
assigning one source multiple group names. `CORROBORATED` requires
qualifying non-ECHO support from at least two distinct source identities
AND at least two distinct independence groups; echoes never count, and a
PRIMARY_CONFIRMATION stays separate confirmation semantics, never ordinary
corroboration. There is still no numeric authority weighting.

When the supplied packet fails validation, the only truthful analysis is a
`WITHHELD_INVALID_PACKET` diagnostic envelope: thesis, mechanism,
implication and stage null; support, contradictions, missingEvidence,
falsifiers, watchNext, unknowns, securityNotes and limitations all empty;
`untrustedTextSeen` and `promptInjectionSuspected` both false — the packet
was rejected before consumption, so Socrates saw nothing and says nothing.
Symmetrically, a VALID packet must never be labeled
`WITHHELD_INVALID_PACKET`: state names mean what they say.

## Closed book

Future SOCRATES-0 operates CLOSED BOOK: it reasons only over the supplied
evidence packet. It does not independently browse the internet. Collectors
gather evidence; Socrates interprets evidence. This keeps provenance
measurable and makes later scoring possible.

## Authority: zero

This contract adds zero trading weight, zero attention weight, zero
stalking weight, zero eligibility authority, zero control authority, zero
execution authority. Validators are pure, fail closed, return bounded
reasons, and never mutate or normalize their input. Unknown or
incompatible schema versions fail closed.

THE MODEL MAY INTERPRET EVIDENCE.
THE MODEL MAY NOT CREATE TRUTH.

## v2 — the research interpreter over real market evidence (MARKET LAB)

The sentence above still governs. v2 adds the machinery, not authority:

- **Evidence v2** (`serpent-evidence-2`, `evidence/contract-v2.js`, `evidence/research-builder.js`) is a compact
  dossier of family summaries derived from a sealed market context plus the read-only Social projection. v1 packets,
  ids, validators and dispatch are untouched; v2 rejects unknown versions and keys and never converts old artifacts.
- **Analysis v2** (`socrates-analysis-2`, `socrates/contract-v2.js`) is assembled by the host from the model's raw
  text: ids, packet binding, schema version and calibration labels are host-derived; a model-supplied id is refused.
  Every citation must resolve inside the packet; a thesis without support is invalid; execution vocabulary fails.
- **The case runtime** (`socrates/runtime.js`) is a state machine: packet validity gate, budget reservation persisted
  before dispatch, the production client, at most two accepted attempts and one follow-up round through the bounded
  broker, a new packet at Q1 >= result receipt, the original packet preserved, sealed CASE bundles that verify offline.
  Terminal states are honest: COMPLETED, INITIAL_REPORT_ONLY, MODEL_FAILED, BUDGET_BLOCKED, DEADLINE_EXCEEDED,
  PACKET_INVALID, CANCELLED. A recorded response is labelled RECORDED_RESPONSE; a reused answer discloses its age.
- **Spend** is a law, not a hope: zero caps mean zero calls, the reservation precedes the request, an ambiguous
  timeout stays counted as spent, a restart cannot reset spent quota, and no cheaper model is substituted silently.
- **Hostile text** (headlines, excerpts, provider errors, broker diagnostics) reaches the model only as data inside the
  dossier; the only HTTP host is the model host; provider URLs are chosen by code, never by the model or by a source.
- **The corpus** (`socrates/corpus.js`, twelve cases, development and held-out split) and the rubric
  (`socrates/evaluate.js`) measure citation validity, unsupported claims, temporal errors, conflated measurements,
  request selection and honest refusal. Scores are an implementation assessment, never stage calibration, a backtest
  or profit proof. A model may reasonably choose a different supported interpretation.
- Authority remains NONE. Research output is read by a person through sealed files and the read-only cockpit drawer.
  No trade button, no order suggestion, no paid toggle, no import of orders, ledger, cost, risk, Judge or Watch.


## Closeout appendix — the seven laws of the market / Socrates repair (R01–R07)

1. **One accounting authority stands before every dispatch.** A provider request is reserved in the stable research
   journal (`<research-root>/accounting`) at the dispatch boundary, in native charge units, under day / month / smoke /
   entitlement / metered caps, or it never reaches the wire. Probe, catalog, acquisition, broker and shared requests use
   the same guard; refusal is truthful usage; an ambiguous failure stays counted; a restart, a rollover, a repeated
   attestation or a clock rollback never re-grant. The model reservation covers the worst billed input class actually
   enabled and needs an exact provider token count.
2. **Completeness is a positive fact.** A trade window is COMPLETE only over a recorded subscription-continuity fact;
   a quiet proven interval is a valid zero; anything else is PARTIAL or UNKNOWN_COVERAGE with observed rows labelled
   observed. An options surface is complete only against a recorded instrument census; a summary and its ticker are one
   contract; a ratio over a subset says so.
3. **Every registered metric has one explicit mapping** from acquisition to context component to packet item, bounded
   and reconciled; absent inputs are MISSING items with no value, never known items with null fields.
4. **The broker satisfies the question that was asked**: per metric, per subject scope, on source and knowledge clocks,
   with every constituent of a derived metric present and compatible; a cache hit is a fresh binding; the same question
   under a new key is never bought twice.
5. **Recording is bounded and every case cites an immutable prefix**: segments rotate before their bound, retention is
   bounded with counted eviction facts, a recording failure stops admission with its first error preserved, and a case's
   inputs resolve offline through sealed segments whose identity is bound to their bytes.
6. **Close is an ownership barrier**: admission stops, owned requests are aborted, the drain is bounded, open
   reservations are preserved as unresolved spend, the lock is released once, and no late result becomes a report.
7. **There is one schema truth**: every component value and support obeys its metric's closed schema at the builder,
   the candidate, the reader and the verifier; a legacy context is rejected, never converted; a resealed mutation is
   exposed by recomputation from the source when the source is supplied, and labelled as unverified when it is not.

Authority remains NONE. Readiness is BLOCKED until the owner supplies entitled keys, attested plans and a dollar
ceiling; no independent acceptance seal is issued by the delivering session.

### Closeout appendix, revision 2 — the five remaining laws (P1–P5)

1. **Readiness is qualified, never counted.** A family is LIVE only from evidence that names its selected required
   provider, a family-relevant registry endpoint, the requested and obtained assets and registered metrics, the measured
   interval, a knowledge clock fresh under the family's own policy age and a support basis; a historical smoke is a
   separate fact; the model needs a supported demonstration; missing proof is named, never thrown.
2. **Accounting commits only what became durable.** A transition is validated, then its bytes are appended, fsynced and
   closed, then the validated state change is applied; a rejected transition writes nothing, a failed or uncertain write
   latches the journal and refuses every later admission, a failed reservation never dispatches, a failed settlement is a
   named failure that admits no data and keeps the reservation charged, and a restart resolves the ambiguous conservatively.
3. **Stop owns its work.** Admission stops; every in-flight acquisition and request (shared, unshared, coalesced, queued)
   is tracked apart from the coalescing map, aborted and drained within a bounded deadline; open reservations are preserved
   as unresolved while the journal is still owned; late continuations are detached; only the admitted prefix is sealed;
   the journal is released last.
4. **Support is demonstrated.** A history interval is complete only over the observations' own period grid with no
   missing period, or over positive coverage records for point observations; a derived candle metric needs its actual
   warmup over a contiguous series; identities are counted once; a cache hit cannot erase a gap.
5. **Every container of the saved context is closed.** Membership is own-property membership; scalars are typed;
   quantities are magnitudes and signed metrics keep their sign; a diagnostic names the path, never the untrusted text.

Authority remains NONE. No readiness claim, acceptance claim, prompt, test or configuration carries a profit target,
a return quota or a forced-trade objective.
