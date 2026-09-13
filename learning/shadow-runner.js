// FORWARD-SHADOW LANE — the bounded, restart-safe runner the learning service can host (default-off there).
// Each step() consumes sealed market-capture bundles through the mirror adapter and drives the EXISTING paced
// shadow lane with EXACTLY ONE capture batch and one maturation batch:
//   - sources are ordered deterministically and read under a per-step wall-clock and bundle budget, starting
//     from a DURABLE round-robin cursor (a CONTROL row), so a many-source host starves nobody — the rotation
//     resumes where it left off across steps AND restarts;
//   - the extracted opportunities of ALL read sources merge into ONE batch sorted by decision clock, then
//     NEWEST window first at an equal clock, then window identity — a single lane.runBatch per step, so the
//     lane's pacing floor is respected instead of self-colliding once per source;
//   - each source segment's consumption cursor (a CONTROL row on the tamper-evident chain) advances exactly
//     to its fully DISPOSED frontier; SHED work stays in front and is retried — queued work is never counted
//     as completed, and a restarted runner replays NOTHING as fresh.
// Nothing here (or below it) can reach an order, a ledger, activation, or the Judge — the fences prove it.
import { readSealedMarketCapture, normalizeMarketRows, extractShadowOpportunities, extractMaturationPaths, ADAPTER_VERSION } from './shadow-market-adapter.js';
import { createShadowLane } from './shadow-lane.js';
import { canonicalDigest, deepFreeze, isTs } from './shadow-contracts.js';
import { sealShadowRecipe } from './shadow-recipe-seal.js';
import {
  acceptedCatalogSnapshotError, buildAcceptedCatalogMapping, catalogControlBody, catalogControlError,
  marketIdentityDigest,
} from './shadow-catalog-snapshot.js';

export const RUNNER_VERSION = 'shadow-runner-5';
export const CURSOR_CONTROL = 'ADAPTER_CONSUMPTION_CURSOR';
export const SEGMENT_CURSOR_CONTROL = 'ADAPTER_SEGMENT_CONSUMPTION_CURSOR';
export const ROTATION_CONTROL = 'BUNDLE_ROTATION';
export const DEFAULT_MAX_BUNDLES_PER_STEP = 4;
export const DEFAULT_MAX_STEP_WALL_MS = 1_500;
export const DEFAULT_MAX_STEP_BYTES = 16 * 1024 * 1024; // per-step BYTE budget on top of the per-member cap

export const segmentCursorControlKey = (source, { recipeVersion, recipeDigest }) => `${SEGMENT_CURSOR_CONTROL}:${canonicalDigest({
  venue: source.venue, canonicalCoin: source.canonicalCoin, marketIdentityDigest: source.marketIdentityDigest,
  dir: source.dir, recipeVersion, recipeDigest,
}).slice(0, 40)}`;

// acceptedCatalogSource is the independently acquired FULL denominator. bundleSource supplies only explicitly
// mapped segments: [{ dir, venue, canonicalCoin, marketIdentityDigest }]. Neither accessor polls or opens a
// socket here. Missing/stale/forged catalog evidence or a non-durable pre-capture control fails the step closed.
export function createShadowRunner({ store, recipe, acceptedCatalogSource, bundleSource, quotas = {}, maxBundlesPerStep = DEFAULT_MAX_BUNDLES_PER_STEP, maxStepWallMs = DEFAULT_MAX_STEP_WALL_MS, maxStepBytes = DEFAULT_MAX_STEP_BYTES, clock = () => Date.now(), monotonic = () => performance.now(), log = () => {} }) {
  if (!store || typeof store.appendControl !== 'function') throw new Error('shadow runner: a shadow store is required');
  if (typeof bundleSource !== 'function') throw new Error('shadow runner: an injected bundle source is required');
  for (const [name, value] of Object.entries({ maxBundlesPerStep, maxStepWallMs, maxStepBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`shadow runner: ${name} malformed`);
  }
  const recipeSeal = sealShadowRecipe(recipe);
  const cursorIdentity = Object.freeze({ recipeVersion: recipeSeal.recipe.recipeVersion, recipeDigest: recipeSeal.recipeDigest });
  const lane = createShadowLane({ store, recipe, quotas, clock, monotonic, log });
  const cursorKey = (marketDigest) => `${CURSOR_CONTROL}:${marketDigest}:${cursorIdentity.recipeVersion}:${cursorIdentity.recipeDigest}`;
  const rotationKey = `${ROTATION_CONTROL}:${cursorIdentity.recipeVersion}:${cursorIdentity.recipeDigest}`;
  const sourceKey = (s) => `${s.marketIdentityDigest}:${s.dir}`;
  const validCursor = (cursor) => cursor && isTs(cursor.lastDecisionTs) && isTs(cursor.lastWindowEndTs);
  const beyondCursor = (frontier, prior) => !validCursor(prior) || frontier.decisionTs > prior.lastDecisionTs
    || (frontier.decisionTs === prior.lastDecisionTs && frontier.windowEndTs < prior.lastWindowEndTs);
  const leastSegmentCursor = (keys) => {
    const cursors = [...keys].map((key) => store.lastControl(key));
    if (cursors.some((cursor) => !validCursor(cursor))) return null;
    return cursors.sort((a, b) => a.lastDecisionTs - b.lastDecisionTs || b.lastWindowEndTs - a.lastWindowEndTs)[0] ?? null;
  };

  function step({ nowTs = clock() } = {}) {
    if (!isTs(nowTs)) throw new Error('shadow runner: clock malformed');
    const startMono = monotonic();
    const report = {
      runnerVersion: RUNNER_VERSION, adapterVersion: ADAPTER_VERSION, bundles: 0, bundlesDeferred: 0,
      refusedBundles: [], captured: 0, captureUnit: 'NEW_VARIANT_CAPTURES', independentEvents: 0,
      independentEventUnit: 'NEW_UNIQUE_OPPORTUNITY_IDS', ineligible: 0, deduped: 0, refusedLate: 0, shed: 0,
      matured: 0, pending: 0, unmaturable: 0, errors: 0, cursorAdvanced: [], catalog: null, denominator: null,
    };
    if (typeof acceptedCatalogSource !== 'function') return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: 'ACCEPTED_CATALOG_SOURCE_REQUIRED' } });
    let snapshot;
    try { snapshot = acceptedCatalogSource(); } catch (err) { log(`shadow runner: accepted catalog source failed dark (${err.message})`); return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: 'ACCEPTED_CATALOG_SOURCE_FAILED' } }); }
    const snapshotError = acceptedCatalogSnapshotError(snapshot, { nowTs });
    if (snapshotError) return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: snapshotError } });
    let rawSources;
    try { rawSources = bundleSource() ?? []; } catch (err) { log(`shadow runner: bundle source failed dark (${err.message})`); return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: 'BUNDLE_SOURCE_FAILED' } }); }
    let mapped;
    try { mapped = buildAcceptedCatalogMapping(snapshot, rawSources); } catch (err) { return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: String(err.message).slice(0, 200) } }); }
    const catalogControl = catalogControlBody({ snapshot, mapping: mapped.mapping, ...cursorIdentity });
    const priorCatalogControl = store.lastControl(catalogControl.control) ?? null;
    if (priorCatalogControl) {
      const controlError = catalogControlError(priorCatalogControl, { nowTs });
      if (controlError) return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: controlError } });
    } else {
      const written = store.appendControl(catalogControl);
      if (!written.ok) return deepFreeze({ ...report, catalog: { status: 'REFUSED', reason: `CATALOG_CONTROL_NOT_DURABLE:${written.refused ?? 'UNKNOWN'}` } });
    }
    const sources = mapped.admitted;
    const catalogState = new Map(snapshot.markets.map((market) => {
      const digest = marketIdentityDigest(market); const mapping = mapped.mapping.mappings.find((row) => row.marketIdentityDigest === digest);
      return [digest, { digest, market, sourceCount: mapping.sourceCount, attemptedSources: 0, validSources: 0, deferredSources: 0, opportunities: [] }];
    }));
    report.catalog = {
      status: 'READY', contentId: snapshot.contentId, contentDigest: snapshot.contentDigest,
      parentCatalogDigest: snapshot.parentCatalogDigest, acceptedMarketCount: snapshot.acceptedMarketCount,
      observedTs: snapshot.observedTs, knownAtTs: snapshot.knownAtTs, maxAgeMs: snapshot.maxAgeMs,
      mappingDigest: mapped.mapping.mappingDigest, mappingFailures: mapped.mapping.failures,
    };
    // deterministic order + durable round-robin: start AFTER the last source consumed in a previous step
    const ordered = [...sources].sort((a, b) => (sourceKey(a) < sourceKey(b) ? -1 : 1));
    const lastKey = store.lastControl(rotationKey)?.lastSourceKey ?? null;
    let start = 0;
    if (lastKey !== null) { const idx = ordered.findIndex((s) => sourceKey(s) > lastKey); start = idx === -1 ? 0 : idx; }
    const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];

    // phase 1 — bounded reads (bundles, wall clock, BYTE budget); what does not fit is DEFERRED to the next
    // rotation, never dropped. ROWS from every bundle of one market MERGE (deduped by observation id) so a
    // path spanning two adjacent sealed segments read in one step is ONE path — a second bundle never
    // overwrites the first (review item 5). Adjacent segments of one market sort adjacent under the source
    // key, so the rotation reads them together whenever the per-step budget allows.
    const perMarket = new Map(); // exact marketIdentityDigest -> merged evidence for that one sealed pair identity
    let lastReadKey = lastKey; let bytesThisStep = 0;
    for (let sourceIndex = 0; sourceIndex < rotated.length; sourceIndex += 1) {
      const src = rotated[sourceIndex];
      const census = catalogState.get(src.marketIdentityDigest);
      if (report.bundles >= maxBundlesPerStep || monotonic() - startMono > maxStepWallMs || bytesThisStep >= maxStepBytes) { report.bundlesDeferred += 1; census.deferredSources += 1; continue; }
      report.bundles += 1;
      census.attemptedSources += 1;
      const read = readSealedMarketCapture(src.dir, { maxInputBytes: maxStepBytes - bytesThisStep });
      bytesThisStep += read.bytesRead ?? 0;
      if (!read.ok) {
        if (read.refused === 'INPUT_BYTE_BUDGET_EXCEEDED' && !(Number.isSafeInteger(read.requiredBytes) && read.requiredBytes > maxStepBytes)) {
          // It fits a fresh step but not the remaining allowance. Stop at this source and retain the rotation
          // frontier: advancing past a deferred segment would hide it from the next step.
          report.bundlesDeferred += rotated.length - sourceIndex;
          for (const deferred of rotated.slice(sourceIndex)) catalogState.get(deferred.marketIdentityDigest).deferredSources += 1;
          break;
        }
        lastReadKey = sourceKey(src); // permanent malformed/oversized refusals stay visible without jamming rotation
        report.refusedBundles.push({ dir: src.dir, refused: read.refused === 'INPUT_BYTE_BUDGET_EXCEEDED' ? 'BUNDLE_EXCEEDS_STEP_BYTE_BUDGET' : read.refused, detail: read.detail });
        continue;
      }
      let identityMismatch = false; let identityProven = false;
      for (const row of read.rows) {
        if (row?.subject?.subjectKind !== 'MARKET') continue;
        let rowDigest;
        try { rowDigest = marketIdentityDigest(row.subject); } catch { identityMismatch = true; break; }
        if (rowDigest !== src.marketIdentityDigest) { identityMismatch = true; break; }
        identityProven = true;
      }
      if (identityMismatch || !identityProven) {
        lastReadKey = sourceKey(src);
        report.refusedBundles.push({ dir: src.dir, refused: identityMismatch ? 'CATALOG_MARKET_IDENTITY_MISMATCH' : 'CATALOG_MARKET_IDENTITY_UNPROVEN', detail: 'sealed observation subjects do not prove the explicitly mapped accepted market' });
        continue;
      }
      census.validSources += 1;
      lastReadKey = sourceKey(src);
      const key = src.marketIdentityDigest;
      const entry = perMarket.get(key) ?? { marketDigest: key, venue: src.venue, coin: src.canonicalCoin, rowsById: new Map(), coverage: [], segments: new Map() };
      for (const row of read.rows) if (!entry.rowsById.has(row.observationId)) entry.rowsById.set(row.observationId, row);
      entry.coverage.push(...read.coverage);
      entry.segments.set(segmentCursorControlKey(src, cursorIdentity), read.bundleId);
      perMarket.set(key, entry);
    }
    report.bytesRead = bytesThisStep;
    if (report.bundles > 0 && lastReadKey !== lastKey) {
      const w = store.appendControl({ control: rotationKey, lastSourceKey: lastReadKey, ...cursorIdentity, adapterVersion: ADAPTER_VERSION });
      if (!w.ok) log(`shadow runner: rotation cursor refused (${w.refused})`);
    }

    // phase 2 — normalize ONCE per market over the MERGED rows, extract behind the least-advanced authoritative
    // per-segment cursor. A coarse per-market cursor cannot safely skip rows when a bundle limit separates two
    // segments of the same market and the later segment contains an older/equal-time opportunity.
    // cursor, then run ONE merged deterministically ordered capture batch (decision clock, then NEWEST window
    // first, then venue/asset): the lane's pacing floor sees one batch per step, never one per source
    for (const m of perMarket.values()) {
      m.normalized = normalizeMarketRows({ rows: [...m.rowsById.values()], coverage: m.coverage }, { venue: m.venue, canonicalCoin: m.coin, candlePeriodMs: recipe.candlePeriodMs });
      const cursor = leastSegmentCursor(m.segments.keys());
      m.opportunities = extractShadowOpportunities({ normalized: m.normalized, recipe, venue: m.venue, canonicalCoin: m.coin, afterCursor: cursor ? { lastDecisionTs: cursor.lastDecisionTs, lastWindowEndTs: cursor.lastWindowEndTs } : null });
      catalogState.get(m.marketDigest).opportunities.push(...m.opportunities);
    }
    const merged = [...perMarket.values()].flatMap((m) => m.opportunities)
      .sort((a, b) => a.decisionTs - b.decisionTs || b.windowEndTs - a.windowEndTs || (`${a.venue}:${a.assetId}` < `${b.venue}:${b.assetId}` ? -1 : 1));
    const opportunityIdsBefore = new Set([...store.captures().values()].map((capture) => capture.opportunityId));
    const r = lane.runBatch({ opportunities: merged, nowTs });
    report.captured += r.captured; report.ineligible += r.ineligible; report.deduped += r.deduped; report.refusedLate += r.refusedLate; report.shed += r.shed;
    const capturesAfter = [...store.captures().values()];
    const opportunityIdsAfter = new Set(capturesAfter.map((capture) => capture.opportunityId));
    report.independentEvents = [...opportunityIdsAfter].filter((id) => !opportunityIdsBefore.has(id)).length;
    // Authoritative COMPOSITE cursors are per source segment. The per-market cursor remains only as backward-
    // compatible telemetry; using it as a skip filter loses older/equal-time work separated by a step limit.
    for (const m of perMarket.values()) {
      const mine = r.cursorSafeDisposed.filter((d) => d.venue === m.venue && d.assetId === m.coin);
      if (!mine.length) continue;
      const frontier = mine[mine.length - 1];
      for (const [key, bundleId] of m.segments) {
        const prior = store.lastControl(key) ?? null;
        if (!beyondCursor(frontier, prior)) continue;
        const w = store.appendControl({ control: key, cursorScope: 'SOURCE_SEGMENT', lastDecisionTs: frontier.decisionTs, lastWindowEndTs: frontier.windowEndTs, bundleId, ...cursorIdentity, adapterVersion: ADAPTER_VERSION });
        if (w.ok) report.cursorAdvanced.push({ key, lastDecisionTs: frontier.decisionTs, lastWindowEndTs: frontier.windowEndTs });
      }
      const key = cursorKey(m.marketDigest);
      const prior = store.lastControl(key) ?? null;
      if (beyondCursor(frontier, prior)) store.appendControl({ control: key, cursorScope: 'MARKET_TELEMETRY_ONLY', lastDecisionTs: frontier.decisionTs, lastWindowEndTs: frontier.windowEndTs, bundleId: null, ...cursorIdentity, adapterVersion: ADAPTER_VERSION });
    }

    // phase 3 — ONE merged maturation batch, each market only from its own later actually received
    // observations (the MERGED per-market rows, so adjacent segments read together complete one path)
    const allPaths = {};
    for (const m of perMarket.values()) {
      const marketCaptures = [...store.captures().values()].filter((c) => c.venue === m.venue && c.assetId === m.coin);
      Object.assign(allPaths, extractMaturationPaths({ normalized: m.normalized, captures: marketCaptures, asOfTs: nowTs }));
    }
    const mm = lane.matureBatch({ paths: allPaths, asOfTs: nowTs });
    report.matured += mm.matured; report.pending += mm.pending; report.unmaturable += mm.unmaturable; report.errors += mm.errors;
    const disposed = new Set(r.cursorSafeDisposed.map((row) => `${row.venue}:${row.assetId}:${row.decisionTs}:${row.windowEndTs}`));
    const durable = new Set(capturesAfter.filter((capture) => capture.recipeDigest === cursorIdentity.recipeDigest)
      .map((capture) => `${capture.venue}:${capture.assetId}:${capture.decisionTs}:${capture.inputWindow?.endTs}`));
    const markets = [...catalogState.values()].map((state) => {
      let disposition;
      if (state.sourceCount === 0) disposition = 'MISSING';
      else {
        const opportunityKeys = state.opportunities.map((opp) => `${opp.venue}:${opp.assetId}:${opp.decisionTs}:${opp.windowEndTs}`);
        const undisposed = opportunityKeys.some((key) => !disposed.has(key));
        if (state.deferredSources > 0 || undisposed) disposition = 'DEFERRED';
        else if (opportunityKeys.some((key) => durable.has(key))) disposition = 'CAPTURED';
        else disposition = 'INELIGIBLE';
      }
      return {
        marketIdentityDigest: state.digest, disposition, sourceCount: state.sourceCount,
        attemptedSources: state.attemptedSources, validSources: state.validSources,
      };
    });
    const count = (state) => markets.filter((row) => row.disposition === state).length;
    const counts = {
      acceptedMarkets: snapshot.acceptedMarketCount,
      visibleMarkets: markets.filter((row) => row.sourceCount > 0).length,
      attemptedMarkets: markets.filter((row) => row.attemptedSources > 0).length,
      capturedMarkets: count('CAPTURED'), ineligibleMarkets: count('INELIGIBLE'),
      deferredMarkets: count('DEFERRED'), missingMarkets: count('MISSING'),
      newIndependentEvents: report.independentEvents, newVariantCaptures: report.captured,
    };
    const reconciled = counts.capturedMarkets + counts.ineligibleMarkets + counts.deferredMarkets + counts.missingMarkets === counts.acceptedMarkets;
    if (!reconciled || counts.visibleMarkets + counts.missingMarkets !== counts.acceptedMarkets) throw new Error('shadow runner: catalog denominator failed reconciliation');
    report.denominator = {
      unit: 'UNIQUE_ACCEPTED_MARKET_IDENTITIES', dispositionLaw: 'CAPTURED|INELIGIBLE|DEFERRED|MISSING_EXACTLY_ONCE',
      captureUnit: 'NEW_VARIANT_CAPTURES', independentEventUnit: 'NEW_UNIQUE_OPPORTUNITY_IDS',
      counts, markets,
    };
    return deepFreeze(report);
  }

  return Object.freeze({ step, status: (nowTs) => lane.status(nowTs), stop: lane.stop, resume: lane.resume });
}
