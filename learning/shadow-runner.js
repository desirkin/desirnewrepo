// FORWARD-SHADOW LANE — the bounded, restart-safe runner the learning service can host (default-off there).
// Each step() consumes sealed market-capture bundles through the mirror adapter, extracts deterministic
// opportunities and maturation paths, and drives the EXISTING paced shadow lane. A durable consumption cursor
// (a CONTROL row on the store's tamper-evident chain, keyed per market) survives restarts, so a rerun over the
// same bundles resumes AFTER the last consumed decision clock instead of replaying old data as fresh
// opportunities — the store's dedupe remains the structural backstop underneath it.
//
// The runner reports only what actually happened: captured / matured / pending / ineligible / deduped / shed /
// refused, per step and cumulatively via the lane status. Queued work is NEVER counted as completed. Nothing
// here (or below it) can reach an order, a ledger, activation, or the Judge — the fences prove it.
import { readSealedMarketCapture, normalizeMarketRows, extractShadowOpportunities, extractMaturationPaths, ADAPTER_VERSION } from './shadow-market-adapter.js';
import { createShadowLane } from './shadow-lane.js';
import { deepFreeze, isTs } from './shadow-contracts.js';

export const RUNNER_VERSION = 'shadow-runner-1';
export const CURSOR_CONTROL = 'ADAPTER_CONSUMPTION_CURSOR';
export const DEFAULT_MAX_BUNDLES_PER_STEP = 2;

// bundleSource: an INJECTED read-only accessor, () => [{ dir, venue, canonicalCoin }] — the runner starts no
// polling, opens no socket and invents no path; the host decides which sealed bundles exist.
export function createShadowRunner({ store, recipe, bundleSource, quotas = {}, maxBundlesPerStep = DEFAULT_MAX_BUNDLES_PER_STEP, clock = () => Date.now(), monotonic = () => performance.now(), log = () => {} }) {
  if (!store || typeof store.appendControl !== 'function') throw new Error('shadow runner: a shadow store is required');
  if (typeof bundleSource !== 'function') throw new Error('shadow runner: an injected bundle source is required');
  const lane = createShadowLane({ store, recipe, quotas, clock, monotonic, log });
  const cursorKey = (venue, coin) => `${CURSOR_CONTROL}:${venue}:${coin}:${recipe.recipeVersion}`;

  function step({ nowTs = clock() } = {}) {
    if (!isTs(nowTs)) throw new Error('shadow runner: clock malformed');
    const report = { runnerVersion: RUNNER_VERSION, adapterVersion: ADAPTER_VERSION, bundles: 0, refusedBundles: [], captured: 0, ineligible: 0, deduped: 0, refusedLate: 0, shed: 0, matured: 0, pending: 0, unmaturable: 0, errors: 0, cursorAdvanced: [] };
    let sources;
    try { sources = bundleSource() ?? []; } catch (err) { log(`shadow runner: bundle source failed dark (${err.message})`); return deepFreeze({ ...report, sourceFailed: err.message.slice(0, 200) }); }
    for (const src of sources.slice(0, maxBundlesPerStep)) {
      report.bundles += 1;
      const read = readSealedMarketCapture(src.dir);
      if (!read.ok) { report.refusedBundles.push({ dir: src.dir, refused: read.refused, detail: read.detail }); continue; }
      const normalized = normalizeMarketRows(read.rows, { venue: src.venue, canonicalCoin: src.canonicalCoin });
      const key = cursorKey(src.venue, src.canonicalCoin);
      const cursor = store.lastControl(key);
      const opportunities = extractShadowOpportunities({ normalized, recipe, venue: src.venue, canonicalCoin: src.canonicalCoin, afterDecisionTs: cursor?.lastDecisionTs ?? null });
      const r = lane.runBatch({ opportunities: [...opportunities], nowTs });
      report.captured += r.captured; report.ineligible += r.ineligible; report.deduped += r.deduped; report.refusedLate += r.refusedLate; report.shed += r.shed;
      // the durable cursor advances EXACTLY to what the lane fully disposed of (captured / ineligible /
      // deduped / refused-late); shed work stays in front of the cursor and is retried, never silently skipped
      if (r.consumedThroughTs !== null && r.consumedThroughTs !== (cursor?.lastDecisionTs ?? null)) {
        const w = store.appendControl({ control: key, lastDecisionTs: r.consumedThroughTs, bundleId: read.bundleId, recipeVersion: recipe.recipeVersion, adapterVersion: ADAPTER_VERSION });
        if (w.ok) report.cursorAdvanced.push({ key, lastDecisionTs: r.consumedThroughTs });
      }
      // maturation: only captures of THIS market, only from later actually received observations
      const marketCaptures = [...store.captures().values()].filter((c) => c.venue === src.venue && c.assetId === src.canonicalCoin);
      const paths = extractMaturationPaths({ normalized, captures: marketCaptures, asOfTs: nowTs });
      const m = lane.matureBatch({ paths, asOfTs: nowTs });
      report.matured += m.matured; report.pending += m.pending; report.unmaturable += m.unmaturable; report.errors += m.errors;
    }
    return deepFreeze(report);
  }

  return Object.freeze({ step, status: (nowTs) => lane.status(nowTs), stop: lane.stop, resume: lane.resume });
}
