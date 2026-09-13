// FORWARD-SHADOW LANE — the bounded, restart-safe runner the learning service can host (default-off there).
// Each step() consumes sealed market-capture bundles through the mirror adapter and drives the EXISTING paced
// shadow lane with EXACTLY ONE capture batch and one maturation batch:
//   - sources are ordered deterministically and read under a per-step wall-clock and bundle budget, starting
//     from a DURABLE round-robin cursor (a CONTROL row), so a many-source host starves nobody — the rotation
//     resumes where it left off across steps AND restarts;
//   - the extracted opportunities of ALL read sources merge into ONE batch sorted by decision clock, then
//     NEWEST window first at an equal clock, then window identity — a single lane.runBatch per step, so the
//     lane's pacing floor is respected instead of self-colliding once per source;
//   - each market's consumption cursor (a CONTROL row on the tamper-evident chain) advances exactly to that
//     market's fully DISPOSED frontier; SHED work stays in front and is retried — queued work is never
//     counted as completed, and a restarted runner replays NOTHING as fresh.
// Nothing here (or below it) can reach an order, a ledger, activation, or the Judge — the fences prove it.
import { readSealedMarketCapture, normalizeMarketRows, extractShadowOpportunities, extractMaturationPaths, ADAPTER_VERSION } from './shadow-market-adapter.js';
import { createShadowLane } from './shadow-lane.js';
import { deepFreeze, isTs } from './shadow-contracts.js';

export const RUNNER_VERSION = 'shadow-runner-3';
export const CURSOR_CONTROL = 'ADAPTER_CONSUMPTION_CURSOR';
export const ROTATION_CONTROL = 'BUNDLE_ROTATION';
export const DEFAULT_MAX_BUNDLES_PER_STEP = 4;
export const DEFAULT_MAX_STEP_WALL_MS = 1_500;
export const DEFAULT_MAX_STEP_BYTES = 16 * 1024 * 1024; // per-step BYTE budget on top of the per-member cap

// bundleSource: an INJECTED read-only accessor, () => [{ dir, venue, canonicalCoin }] — the runner starts no
// polling, opens no socket and invents no path; the host decides which sealed bundles exist.
export function createShadowRunner({ store, recipe, bundleSource, quotas = {}, maxBundlesPerStep = DEFAULT_MAX_BUNDLES_PER_STEP, maxStepWallMs = DEFAULT_MAX_STEP_WALL_MS, maxStepBytes = DEFAULT_MAX_STEP_BYTES, clock = () => Date.now(), monotonic = () => performance.now(), log = () => {} }) {
  if (!store || typeof store.appendControl !== 'function') throw new Error('shadow runner: a shadow store is required');
  if (typeof bundleSource !== 'function') throw new Error('shadow runner: an injected bundle source is required');
  const lane = createShadowLane({ store, recipe, quotas, clock, monotonic, log });
  const marketKey = (venue, coin) => `${venue}:${coin}`;
  const cursorKey = (venue, coin) => `${CURSOR_CONTROL}:${marketKey(venue, coin)}:${recipe.recipeVersion}`;
  const rotationKey = `${ROTATION_CONTROL}:${recipe.recipeVersion}`;
  const sourceKey = (s) => `${marketKey(s.venue, s.canonicalCoin)}:${s.dir}`;

  function step({ nowTs = clock() } = {}) {
    if (!isTs(nowTs)) throw new Error('shadow runner: clock malformed');
    const startMono = monotonic();
    const report = { runnerVersion: RUNNER_VERSION, adapterVersion: ADAPTER_VERSION, bundles: 0, bundlesDeferred: 0, refusedBundles: [], captured: 0, ineligible: 0, deduped: 0, refusedLate: 0, shed: 0, matured: 0, pending: 0, unmaturable: 0, errors: 0, cursorAdvanced: [] };
    let sources;
    try { sources = (bundleSource() ?? []).filter((s) => s && typeof s.dir === 'string'); } catch (err) { log(`shadow runner: bundle source failed dark (${err.message})`); return deepFreeze({ ...report, sourceFailed: String(err.message).slice(0, 200) }); }
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
    const perMarket = new Map(); // marketKey -> { venue, coin, rowsById: Map, coverage: [], bundleId }
    let lastReadKey = lastKey; let bytesThisStep = 0;
    for (const src of rotated) {
      if (report.bundles >= maxBundlesPerStep || monotonic() - startMono > maxStepWallMs || bytesThisStep > maxStepBytes) { report.bundlesDeferred += 1; continue; }
      report.bundles += 1; lastReadKey = sourceKey(src);
      const read = readSealedMarketCapture(src.dir);
      if (!read.ok) { report.refusedBundles.push({ dir: src.dir, refused: read.refused, detail: read.detail }); continue; }
      bytesThisStep += read.bytesRead ?? 0;
      const key = marketKey(src.venue, src.canonicalCoin);
      const entry = perMarket.get(key) ?? { venue: src.venue, coin: src.canonicalCoin, rowsById: new Map(), coverage: [], bundleId: read.bundleId };
      for (const row of read.rows) if (!entry.rowsById.has(row.observationId)) entry.rowsById.set(row.observationId, row);
      entry.coverage.push(...read.coverage); entry.bundleId = read.bundleId;
      perMarket.set(key, entry);
    }
    report.bytesRead = bytesThisStep;
    if (report.bundles > 0 && lastReadKey !== lastKey) {
      const w = store.appendControl({ control: rotationKey, lastSourceKey: lastReadKey, adapterVersion: ADAPTER_VERSION });
      if (!w.ok) log(`shadow runner: rotation cursor refused (${w.refused})`);
    }

    // phase 2 — normalize ONCE per market over the MERGED rows, extract behind the COMPOSITE per-market
    // cursor, then run ONE merged deterministically ordered capture batch (decision clock, then NEWEST window
    // first, then venue/asset): the lane's pacing floor sees one batch per step, never one per source
    for (const m of perMarket.values()) {
      m.normalized = normalizeMarketRows({ rows: [...m.rowsById.values()], coverage: m.coverage }, { venue: m.venue, canonicalCoin: m.coin, candlePeriodMs: recipe.candlePeriodMs });
      const cursor = store.lastControl(cursorKey(m.venue, m.coin));
      m.opportunities = extractShadowOpportunities({ normalized: m.normalized, recipe, venue: m.venue, canonicalCoin: m.coin, afterCursor: cursor ? { lastDecisionTs: cursor.lastDecisionTs, lastWindowEndTs: cursor.lastWindowEndTs ?? -Infinity } : null });
    }
    const merged = [...perMarket.values()].flatMap((m) => m.opportunities)
      .sort((a, b) => a.decisionTs - b.decisionTs || b.windowEndTs - a.windowEndTs || (`${a.venue}:${a.assetId}` < `${b.venue}:${b.assetId}` ? -1 : 1));
    const r = lane.runBatch({ opportunities: merged, nowTs });
    report.captured += r.captured; report.ineligible += r.ineligible; report.deduped += r.deduped; report.refusedLate += r.refusedLate; report.shed += r.shed;
    // COMPOSITE per-market cursor (review P0): advance each market EXACTLY through its own entries in the
    // lane's cursor-safe disposed prefix — the last such entry, in batch order, carries both the decision
    // clock and the immutable window identity, so same-clock sibling windows are never dropped and a market
    // whose work was shed or deferred never advances at all
    for (const m of perMarket.values()) {
      const mine = r.cursorSafeDisposed.filter((d) => d.venue === m.venue && d.assetId === m.coin);
      if (!mine.length) continue;
      const frontier = mine[mine.length - 1];
      const key = cursorKey(m.venue, m.coin);
      const prior = store.lastControl(key) ?? null;
      const beyond = prior === null || frontier.decisionTs > prior.lastDecisionTs
        || (frontier.decisionTs === prior.lastDecisionTs && (frontier.windowEndTs ?? Infinity) < (prior.lastWindowEndTs ?? Infinity));
      if (beyond) {
        const w = store.appendControl({ control: key, lastDecisionTs: frontier.decisionTs, lastWindowEndTs: frontier.windowEndTs, bundleId: m.bundleId, recipeVersion: recipe.recipeVersion, adapterVersion: ADAPTER_VERSION });
        if (w.ok) report.cursorAdvanced.push({ key, lastDecisionTs: frontier.decisionTs, lastWindowEndTs: frontier.windowEndTs });
      }
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
    return deepFreeze(report);
  }

  return Object.freeze({ step, status: (nowTs) => lane.status(nowTs), stop: lane.stop, resume: lane.resume });
}
