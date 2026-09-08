# SOCIAL-5B — offline research history / outcome / evaluation pipeline (operator guide)

`bin/social-research.js` is a standalone, OFFLINE research tool. It reads a durable Social/RUMOR journal prefix
READ ONLY, reads an EXISTING immutable Childhood archive, and writes disposable, reproducible research artifacts.
It never starts a runtime, never opens a provider, never spends, never touches the ledger / cost / controls / risk /
execution paths, and its outputs are not inputs to any operational decision (`authority: NONE`, `purpose:
RESEARCH_ONLY`). It performs **no stage calibration**: the live stage remains `UNKNOWN / calibrated:false`.

## Commands (three, dependent, in order)

```
node bin/social-research.js snapshot  --database-url-env SOCIAL_RESEARCH_DATABASE_URL --out <NEW_SNAPSHOT_DIR>
node bin/social-research.js build     --snapshot <SNAPSHOT_DIR> --childhood-dir <EXISTING_ARCHIVE_DIR> \
                                      --as-of 2026-09-08T00:00:00Z --out <NEW_DATASET_DIR>
node bin/social-research.js evaluate  --dataset <DATASET_DIR> --split-at 2026-09-07T12:00:00Z --out <NEW_REPORT_DIR>
```

- `snapshot` is the ONLY command that opens a database, through the ONE environment variable you name
  (`--database-url-env`). There is no default, no `DATABASE_URL` fallback, no URL argument and the URL is never
  printed. It opens one transaction whose first statement is `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ
  ONLY`, proves it server-side (`SHOW transaction_read_only` / `transaction_isolation`, recorded in the manifest),
  captures the `rumor2` upper sequence inside that snapshot and reads keyset pages bounded by it. No fence, lock,
  append, checkpoint, migration or schema creation. Concurrent later appends cannot change the export.
- `build` / `evaluate` never connect to anything, even when credentials exist in the environment.
- `--childhood-dir` may be omitted: the dataset then carries `OUTCOME_UNAVAILABLE` labels and a coverage report
  naming `CHILDHOOD_ARCHIVE_NOT_SUPPLIED` (exit 0 — missing data is an honest result, not a failure).
- `--as-of` is mandatory and must be an unambiguous UTC instant (`YYYY-MM-DDTHH:MM:SSZ`, optional `.mmm`); the
  wall clock is never used. `evaluate` inherits the dataset's frozen as-of; `--split-at` must be earlier than it
  and is chosen by you BEFORE any outcome is read — never selected from outcomes.
- Unknown / duplicate / valueless flags, positional extras, non-UTC clocks and invalid paths are refused.
- `--help` prints usage and performs no other I/O. Importing the CLI or any `research/` module has no side effects.

### Exit codes
| code | meaning |
|---|---|
| 0 | completed honestly — including missing / insufficient history (read the coverage report) |
| 2 | invalid request (flags, clocks, output directory exists / overlaps an input or the source tree) |
| 3 | corrupt or inconsistent input (journal gap / duplicate / unparseable payload, lineage, checksum, schema, unsupported version) |
| 4 | a named resource limit was exceeded (no partial artifact is ever sealed) |
| 5 | execution / I/O / permission / connection failure |

JSON and human reports distinguish unavailable DATA (`coverage.state`, reason codes, exit 0) from broken EXECUTION
(a nonzero exit, a JSON error `{code, message, exitCode}` on stderr, no manifest written).

## Output directories

Every target must be a NEW directory outside the git / source tree and outside every input (real paths and
symlinks are resolved; aliases and overlap are refused). There is no overwrite / force mode. The directory is
reserved exclusively, data files are streamed and validated, and the manifest is written LAST (atomic rename):
readers require the final manifest and every checksum, so an interrupted run leaves no readable artifact.

```
<SNAPSHOT_DIR>/  snapshot.manifest.json   snapshots.jsonl
<DATASET_DIR>/   dataset.manifest.json    features.jsonl   outcomes.jsonl   coverage.json
<REPORT_DIR>/    evaluation.manifest.json evaluation.json  report.txt
```

## Schemas and recipes (all closed, all versioned, revalidated on read)

| artifact | version | notes |
|---|---|---|
| snapshot | `social-research-snapshot-1` | `RESEARCH_DOSSIER_V2` and `RESEARCH_SHADOW_SAMPLE` projection records in original journal order; `originalSeq` preserved; `origin` is `LIVE_JOURNAL` or `FIXTURE` |
| prefix digest | `social-research-prefix-digest-1` | sha256 over `"<seq>\n<canonicalJson(event)>\n"` for EVERY event `1..upperSeq`, projected or not — a local provenance checksum, never an attestation, never a claim that sparse projected sequences form a replayable journal |
| features | `social-research-features-1` | one `PRIMARY` row per research episode (its FIRST durable v2 dossier, all entrances / states); `SHADOW` rows = the existing deterministic selected rows; `rowId = r5f-sha256(recipe + semantic identity)` |
| labels | `social-research-candle-labels-1` | see below |
| split | `social-research-chronological-split-1` | DISCOVERY / VALIDATION / EMBARGOED / DESCRIPTIVE_ONLY by dependency group |
| manifests | `social-research-dataset-manifest-1`, `social-research-evaluation-1` | full input hashes, code identity (source-tree sha256 + git commit + dirty flag), fixed as-of / split, census / exclusion counts, output checksums; never a path, a credential, `Date.now()` or a random id |

The feature catalogue (`research/contracts.js` `FEATURE_CATALOGUE`, 319 leaves + 12 bounded arrays) lists every
projected field's original recorded path, unit, null meaning, **explicit nullability flag** and support-window rule.
Nullability is a machine-readable boolean checked against its own prose at module load — never inferred from English
(the phrase "never null" contains the substring "null"). Only catalogued finite numbers, booleans, closed enums, ids,
timestamps and bounded arrays are copied; free text (notes, details, descriptions, reasons, post bodies, handles,
packets) can never be exported — a projection refuses such leaves.

**One validator, both directions.** Generated records and loaded records obey the same laws: every bounded array
member is revalidated with exact member keys and closed member values (not merely a bounded length), the free-text
scan runs on read as well as on write, and asset fields use the ONE canonical asset-identity law
(`/^[A-Z0-9][A-Z0-9.]{0,14}$/`, so a lawful dotted symbol such as `A.B` round-trips) rather than the uppercase
reason-code pattern. Closed member values are the AUTHORITATIVE upstream vocabularies, imported rather than
restated (entrance kinds, research states, claim types, cross-sense descriptors, proposal kinds, packet reason
codes, dependency node kinds and edge relations): a projected member must be a value the upstream law actually
defines, not merely an uppercase-shaped token. That import is vocabulary reuse only and grants no operational
import or authority.

**Recorded latencies are arithmetic, not free counts.** The originating dossier contract derives
`clock.derivationLatencyMs` as `featureAsOfTs - decision.latestInputKnownAtTs` and `clock.ageFromFirstKnownMs` as
`featureAsOfTs - decision.firstTriggerKnownAtTs`. A loaded record whose recorded latency disagrees with its own
unchanged input clocks is inconsistent and is refused — never clamped, re-dated or repaired — at the projection
boundary and on the feature row alike. No formula is invented for a clock whose derivation the source does not state.

**The SHADOW record is closed too.** `shadowContext` is validated against the source sweep's own laws: exact keys,
population accounting (`unnoticed + noticed = evaluated`, and evaluated plus each declared exclusion reason accounts
for every scanned row), version/recipe/digest/cap bounds, the coverage verdict against its own exclusion counts, the
`min(cap, unnoticed)` selection rule, and agreement of the repeated sweep identity and clock with the enclosing row.
`shadow.selectionReason` and `shadow.preCooldownVerdict` are the source's closed vocabularies — not an uppercase
shape — and the reason is bound to the verdict it did or did not suppress. Nothing PRIMARY is required of a shadow.

**Optionality is not nullability.** A leaf the catalogue declares REQUIRED can never be omitted from a row nor
moved into `absentFeatures`, whatever marker that map carries; only a leaf declared optional may be absent, and
only under one of the two lawful markers (`NOT_RECORDED`, `SHADOW_ROW_NO_SOCIAL_DEPENDENCY`). `absentFeatures`
carries no undeclared name, and the row's `entrances` must be its own projected entrances without repeats.

**Nested input clocks obey the row's clock law, against the DERIVATION clock.** An input cannot be known after the
derivation it fed and cannot be observed after it became known — applied not only to the row-level clocks but to the
dossier's own catalogued member clocks: trigger, claim, coverage-check, wide-eye notice and dependency-node clocks.
The bound is `featureAsOfTs`, not `decisionKnownAtTs`: the dossier is derived as of its own clock and only later
becomes a durable decision, and upstream `validateDependencyManifest` bounds dependency-node clocks by that same
`asOfTs`. An input arriving between the two could not have fed the earlier derivation. (In the current v2 schema the
two clocks are equal by validation; their roles stay distinct.) This is the dossier's declared relationship applied
to the projection, never one universal cutoff over every timestamp-shaped field.

**The retained dependency graph keeps the relationships that make it a graph.** The projection copies nodes and
edges, so the originating law survives the copy: unique node identities, a required clock on every node, closed
kinds and relations, edge endpoints that exist, no self-dependency, no repeated `(from, to, relation)` edge, no
derived node dated before its parent, and no cycle. The same check runs at generation, snapshot reopening, feature
reopening and evaluation. A truncated manifest keeps its truncation disclosure and its `DESCRIPTIVE_ONLY`
consequence — truncation never legalizes a malformed retained graph and never fabricates the omitted nodes.

**The dataset as-of wall.** A dataset is only meaningful under the as-of it was frozen for. Reopening it — through
`readDatasetDir` or `evaluate` — proves every row still obeys that clock: a decision, an input clock, a reference
price or a KNOWN/CENSORED horizon beyond the as-of, or a value masked although that clock could already see it, is
`CORRUPT_INPUT` (exit 3). Rows are never silently re-dated and no archive clock is adjusted to make a row fit. Row
identity is exact SET equality between features and labels (unique ids, a bijection) — equal counts never suffice,
so a duplicated feature beside an orphan label cannot balance the books. The manifest's own summary, the coverage
report and the rows on disk must reconcile.
Source-profile context is `NOT_RECORDED_IN_DOSSIER` for this recipe; claim association is
`NOT_AVAILABLE_NO_AUTHORIZED_SEAM`. Neither is reconstructed from present-day state.

### Clocks (milliseconds vs seconds)
- Journal / dossier / row clocks are **epoch milliseconds**: `featureAsOfTs` (the recorded `dossier.asOfTs`),
  `decisionKnownAtTs` (the durable event's `knownAtTs`; the outcome anchor). In the current v2 schema they are
  equal by validation; their roles stay distinct.
- Childhood candles are **epoch seconds** (`[openSec, o, h, l, c, v]`, `retrievedSec`). A candle open at or above
  `1e11` is treated as unit confusion and refused.

### Label recipe (candle-only, delayed anchor)
```
anchorTsMs   = ceil(decisionKnownAtTs / 60000) * 60000        anchorLagMs in [0, 60000)
reference p  = close of the 1m bar opening at anchorTsMs/1000 - 60   (fully closed at the anchor; no stale substitute)
horizons H   = 1, 3, 5, 15, 30, 60, 240 minutes: bars at EVERY open from the anchor through anchor + H*60 - 60 s,
               and source coverage (retrievedSec) through the final close
mfePct       = max(0, (max(high) / p - 1) * 100)        maePct = min(0, (min(low) / p - 1) * 100)
logReturnPct = 100 * ln(finalClose / p)   for 60m / 240m only, labelled LOG_RETURN_PERCENT (not a simple return)
horizonEndTs = anchor + H*60000;  outcomeKnownAtTs = max(horizonEndTs, archiveCreatedTs, series retrievedTs)
```
**Outcome states are validated as COMBINATIONS, not only as members.** A `KNOWN` horizon carries reason `COMPLETE`,
finite excursion values and a `KNOWN` reference price; `CENSORED` uses only the missing-window / coverage reasons
with null values; `NOT_YET_KNOWN` uses `NOT_YET_KNOWN_AT_AS_OF` with null values and a floor after the as-of;
`OUTCOME_UNAVAILABLE` carries null values and no floor at all. A row that cannot reach its archive, track, series,
provenance or reference bar is unavailable *entirely* — one reason, no reference, no horizon outcomes — so a verdict
such as `ARCHIVE_ABSENT` can never sit beside a `KNOWN` excursion. A masked reference cannot coexist with a resolved
horizon, and the row verdict is exactly the recipe's function of its horizon states. Two lawful combinations are
preserved deliberately: `AVAILABLE` never meant "already known" (a row every one of whose horizons is still masked
at the as-of is `AVAILABLE / COMPLETE`), and an all-censored row stays `PARTIAL / INTERIOR_BAR_MISSING`.

**The contextual archive floor.** Row-local law can prove anchor arithmetic, value/state consistency and as-of
masking, but it cannot prove a *knowledge floor*, because the fact that fixes it — when the archive carrying the
candles came into existence — is not in the row. So the containing dataset's validated provenance is applied too.
The archive reader already proves retrieval `R <= creation C` for every series it consumes, which collapses the
recipe's `max(A, C, R)` and `max(H, C, R)` to `max(A, C)` and `max(H, C)` exactly; a lawful saved dataset's floors
are therefore recomputable from metadata it already records, with no re-read and no new per-row schema. Equality to
the recipe is required, not merely "some later timestamp". A dataset built with no archive must report
`ARCHIVE_ABSENT` on every row; one whose archive records no creation clock must report `PROVENANCE_CLOCK_MISSING`.
The same context carries the archive's validated 1m symbol inventory, so a declared source absence and a KNOWN
outcome can no longer coexist: an empty inventory is `NO_1M_TRACK` for every row and an asset outside a non-empty
one is `SERIES_ABSENT_FOR_ASSET`, following `labelRow`'s own missing-source priority. Missing source is not a
censored observed series — the unavailable branch is retained, not softened — and no archive is reopened during
`evaluate`.
A supplied context that is malformed is corruption — it is never downgraded to "no context" — while *omitting* the
context is a different thing again: a pure row-only call, which makes no claim about any archive. This rejects
contradictions with recorded lawful context; it is not, and does not claim to be, independent attestation that
those recorded source facts are true.

States: `KNOWN`, `CENSORED` (a missing interior / end bar or short source coverage: never a zero return),
`NOT_YET_KNOWN` (the dataset as-of is before the knowledge floor: every value null, the reference price too),
`OUTCOME_UNAVAILABLE` (no archive / no 1m track / no series / no reference bar / no temporal overlap / missing
provenance clock). **The anchor and reference price are label-side only**: a decision between minutes did not
have that price available — it is a delayed candle reference, never an entry fill, a signal price or a performance
claim. Nothing resolves high/low ordering, fees, slippage, liquidity, fills or edge. Canonical numbers are rounded
to four decimals; negative zero is normalized; NaN / Infinity are refused.

### Evaluation
**The payload is validated before its report is trusted.** A report renderer is not a validator: `report.txt` being
the exact rendering of `evaluation.json` proves only that the two agree, and it renders a negative population or a
false `stageCalibration: PERFORMED` just as faithfully as a true one. One complete payload validator therefore runs
at generation, at publication and on standalone reopening, and only then is the rendering required to match. It
fixes this implementation's constants (`pipelineExecution: COMPLETE`, `evaluation:
RETROSPECTIVE_DESCRIPTIVE_ONLY`, `fittedModel: NONE`, `stageCalibration: NOT_PERFORMED`, `currentRuntimeStage:
UNKNOWN`, authority `NONE` / purpose `RESEARCH_ONLY`), requires the standing calibration blockers and laws, and
checks every count and summary: a one-observation summary's order statistics all coincide (a spread over a single
KNOWN outcome is not something the recipe could produce), populations partition (`total = primary + shadow`; split counts sum to the primary
cohort; group split counts sum to the group total; shadow period counts sum to the shadow cohort), each horizon's
four state counts sum to its `n`, each table's `n` is its cohort population, the all-primary table is exactly the
sum over the splits it partitions, a summary's `n` is its table's `KNOWN` count with ordered finite quantiles
(`min <= p25 <= median <= p75 <= max`, all null when `n = 0`, MFE never negative, MAE never positive, log-return
summaries only at 60m/240m), and `discoveryTrainableAtSplit <= discoveryKnownRetrospectively`, with the latter equal
to the DISCOVERY table's `KNOWN` count. Every recorded group's split is re-derived by the one shared split predicate the producer uses, in its exact
priority order, and the visible summaries reconcile with the declared per-split group and row counts. Coverage
reasons and the other closed codes are checked against their authoritative vocabularies, not a character shape.
Group-summary detail keeps its 500-entry ceiling: when complete the group rows and per-split counts reconcile
exactly, when truncated the flag, length and bounds are checked and no omitted entry is invented (and a group's
capped asset list is never read as the whole universe). At `evaluate` the payload is additionally proved
equal to what the deterministic evaluator produces for the source rows actually consumed, bound to the input
digests. A standalone reopening has only the artifact: it enforces the complete local schema and arithmetic without
the original dataset, and does not pretend to recompute quantiles from source rows it does not have.

Rows are grouped transitively by episode identity and shared concrete provenance refs (`SOCIAL_SOURCE`,
`TEXT_FAMILY`, `NATIVE_ORIGIN_REF`, `OFFICIAL_SOURCE`, `CLAIM`, `WIDE_EYE_NOTICE`, `MARKET_SNAPSHOT`); generic
`DOSSIER_FIELD` / `COVERAGE_BOUNDARY` / `SOCIAL_FEATURE_WINDOW` labels never connect rows. A group is not proof of
independence. Feature support starts at the earliest of the episode onset, the earliest concrete dependency clock and
`featureAsOfTs` minus each non-null feature's documented lookback (participation windows 8,100,000 ms; wide-eye
z-scores 7 days; 24h volume 1 day; 15-minute extension; owner flow 15s/1m/5m); a feature without documented finite
support (cumulative session CVD, provider account-age ratios) makes its group `DESCRIPTIVE_ONLY`, as does a
truncated dependency manifest. Outcome support ends at anchor + 240 min for every primary row. A group crossing the
split on those intervals is `EMBARGOED` as a whole. Per-horizon as-of learnability (label knowable at the split for
discovery; at the as-of for validation) is reported separately from retrospective availability and is never
backdated. Percentiles use linear interpolation at index `(n-1)p`; n=0 → null; n=1 → the value. Shadow rows form
separate descriptive tables (not matched controls, not a market denominator). No random split, fitted cutoff,
classifier, causal / significance claim, profitability headline, composite ranking or row weighting exists.

### Producer / consumer bounds and provenance
Writers enforce the SAME byte bounds their readers enforce, under the same accounting: a record is charged its
serialized bytes PLUS the newline the writer emits, and the reader charges a terminated line that same newline (a
final line with no terminator is charged its actual bytes — no byte is invented). So no run can seal an output a
reader would refuse; a bound tripped mid-file closes its descriptor and leaves no artifact. `writeSync` may accept
fewer bytes than requested, so every writer loops to the last byte and treats zero progress as a failure — a short
write can never become a digest and record count that claim more than was written, and a failed write, flush or
validation never becomes a successful seal.

**A primary close and a best-effort release are different operations.** On the success path a reported close
failure means the bytes are not known to be on disk: it is `IO_FAILURE` and the temporary file is never renamed, so
no completion manifest exists. On a path that is already failing, cleanup releases the descriptor and never masks
the error that brought it there — a cleanup helper can no longer swallow a primary close failure and let success
continue. Both mark the descriptor closed *before* calling close, because an operating system may release a
descriptor and still report a failure; that fd is never retried, so nothing double-closes or closes a reused
number.

**Every production JSONL member is consumed exactly once**, in bounded chunks, with the digest taken over precisely
the bytes its records are parsed from — publication verification, artifact reopening and the Childhood archive
(candle tracks and the auxiliary census members alike) all share that single read. There is no checksum pass
followed by a separate reopen whose bytes the digest never saw, and no whole file is buffered to feed a streaming
iterator. Peak memory is one chunk plus the longest record plus each consumer's own bounded state (only the raw 1m
track is retained; coarser tracks are validated one series at a time and discarded). A streaming UTF-8 decoder
handles characters split across chunk edges and rejects malformed or truncated UTF-8 rather than substituting a
replacement character. The descriptor is closed on every exit — normal end, a bound or parse failure, and an early
`break` by the caller — and a reader abandoned before EOF publishes no digest, size or record count at all.

**A manifest is sealed only under the reader's own bundle law** (`research/bundle.js`, with the metadata schemas in
`research/schemas.js`). A checksum proves bytes were not altered afterwards; it never proved they were lawful. The
SAME whole-bundle validator therefore runs twice: once on the unsealed candidate, before the manifest is written and
while the run can still be abandoned, and once on reopening. The object the law is handed is the exact immutable
candidate whose bytes are then serialized, so a proof cannot be run against some other object and nothing can change
between the proof and the write. The bundle law covers:

- the member LIST, fixed by artifact kind and never derived from the untrusted list being checked (an omitted member
  or checksum entry is a corrupt manifest, not a smaller artifact), plus each output descriptor's own closed shape
  (`name, lines, bytes, sha256` for JSONL; `name, bytes, sha256` otherwise) and a traversal-free member name;
- every row under its own validator, and the snapshot's declared clock range and projected/shadow census against the
  records actually sealed;
- **complete nested metadata**: `inputs` is required provenance, so `inputs: null` is corruption — an archive-free
  dataset still records its snapshot input and states `inputs.childhood: null` explicitly. Snapshot and archive
  identities, digests, versions, consumed-file inventories, clocks, counts, recipe copies, recorded limits and code
  identity all have declared closed shapes, and repeated facts must AGREE (a manifest digest recorded twice, a
  creation clock recorded as both ISO text and milliseconds). Recorded limits describe the producing artifact and
  never raise the reader's own;
- the dataset's declared census and counts against the aggregates RECOMPUTED from the sealed rows — two matching but
  wrong copies satisfy nothing — and, at build time, the source-dependent aggregates against the validated snapshot
  actually consumed. The archive census is itself closed: `source` and each `tracks` entry have exact shapes, track
  keys agree with the consumed-file names, one shared schema governs both recorded copies of `consumedFiles`, and
  the 1m symbol inventory is unique, canonical, sorted and consistent with the track census that produced it. Asset
  overlap, the archive series count and `temporalOverlap` are recomputed from the rows and that validated inventory;
  the cohort overlap list is checked as the sorted intersection under its own 200-entry projection cap while
  `counts.overlapCoins` is the full intersection — a capped list is never read as a complete population;
- the recorded code identity as a RELATION, not a membership: `law` must be the law its own commit and cleanliness
  produce, and closure paths must be unique and repository-relative — a dirty closure can no longer be recorded
  beside a clean-commit label;
- **the evaluation payload, validated first and completely** (see below), and only then `report.txt` against the
  deterministic rendering of that payload.

**Diagnostics never echo input.** A rejected record is described by safe structural facts — the declared field name
we were looking for, the ordinal position of an undeclared one, the JavaScript type of a bad value — never by the
value or key text the input supplied, and never by a raw driver or OS message. A length cap is not sanitization.
This holds on the manual paths too: an unknown feature, absent-feature or shadow-feature name, an unsupported
version, a series symbol, and the *path* of a rejected free-text leaf all report position rather than content — a
segment is named only when it is one this codebase itself declares. Repository-defined explanatory constants in
generated artifacts are a different thing and are unaffected.

An archive whose manifest claims it was created BEFORE a series it consumed is corrupt input. **A supplied
`archiveCreatedTs` that is not a lawful UTC instant is also corrupt input** — a garbled clock is never silently
rewritten as "no clock recorded"; only a genuinely absent one (null, or the key omitted) is the explicit
`PROVENANCE_CLOCK_MISSING` limitation with unavailable labels. `codeIdentity` hashes the DISCOVERED source closure
reachable from the entry points — including transitive dependencies such as the evidence contract the dossier
validator executes — so a change confined to one of them changes the digest and the dirty verdict; a dirty closure
is never attributed to a clean HEAD. Its law is one of four states: `PRODUCED_BY_UNCOMMITTED_SOURCE`,
`PRODUCED_BY_COMMITTED_SOURCE`, `NO_GIT_CHECKOUT`, and **`SOURCE_CLEANLINESS_UNKNOWN`** — when a commit is named but
the cleanliness check did not answer (git absent, refused or timed out), the artifact says so rather than claiming
committed source. That inventory is provenance only and grants no module any operational import or authority (the
import fences decide that).

### Resource limits (`research/contracts.js` `LIMITS`, recorded in every manifest)
250,000 source events · 256 MiB cumulative journal payload · 100,000 projected snapshots · 50,000 selected rows ·
256 MiB per consumed input file · 8 MiB per JSONL line · 250,000 candles per series · 192 / 384 dependency nodes /
edges per row · 2,000,000 grouping edges. Exceeding any limit is `RESOURCE_LIMIT_EXCEEDED` with no complete
artifact — never a quiet truncation.

## Fixture walkthrough
`test/social-5b-pipeline.test.js` (T05) builds a lawful in-memory journal (catalog + scope + one Bluesky observation
of `$ZQQ7` + one v2 dossier + one shadow sample), snapshots it (`origin: FIXTURE`, 2 projected records, upper
sequence 5), writes a synthetic archive with one linear 1m series, builds a dataset as of the next day (1 primary +
2 shadow rows; the shadow row of the noticed coin is not selected by the recipe), and evaluates it with an explicit
split. Hand-checked: decision at `12:00:05Z` → anchor `12:01:00Z`, lag 55,000 ms; reference close 105.25; 1-minute
MFE 1.1876 % / MAE −0.2375 %. The report states `stageCalibration: NOT_PERFORMED` and `currentRuntimeStage:
UNKNOWN` with the calibration blockers.

### Compatibility
No artifact shape or recipe version changed in this closeout: the completed laws are enforced against the fields the
current producers already emit, so an artifact produced by this build is read by this build. Corrupt artifacts are
rejected, never normalized or repaired while reading, and there is no silent legacy conversion. `ARRAY_CATALOGUE`
now records `dependencyNodes.knownAtTs` as required rather than nullable — a correction to the projection table,
which never matched the upstream contract that always required the clock; no lawful artifact carried a null there.

## What this pipeline does not claim
It does not create propagation, coordination, baselines, entrances, dossiers, episodes, shadow sampling or source
profiles (they already exist), does not train or calibrate a stage classifier, does not rank sources, simulate
trades or produce edge claims, and does not repair or extend historical universe coverage
(`SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET` and the fast-memory parity limitation are preserved from the archive).

Code that passes its own validators is not evaluated history. **No real history has been evaluated here**; the live
stage remains `UNKNOWN / calibrated:false` with no fitted model and no operational use. Standalone artifact
validation establishes the declared schema, internal consistency and byte integrity of what is in front of it — it
is not independent attestation of source datasets that are absent: an offline reader without the originals cannot
prove that consistently rewritten identities and provenance are true. Track-wide coverage cannot prove any
individual candle window, and a sparse projection is never a complete replayable journal. The external provider,
data-acquisition, claim-association-seam and `serpent-evidence-1` packet limitations all remain open.
