// RUMOR-2A — thin barrel. The pure truth core of the multi-source rumor
// intelligence layer, split into cohesive sibling modules and re-exported
// here so the 60 public names keep their single import surface unchanged.
// No logic lives in this file; every symbol is defined in a truth-*.js
// sibling and re-exported verbatim below.
export {
  RUMOR2_VERSION, RUMOR2_CHECKPOINT_VERSION, MAX_TXN_EVENTS, RECONCILE_TAIL_BYTES,
  MAX_FEED_BYTES, MAX_FEED_ITEMS, MAX_BOOTSTRAP_ITEMS, MAX_TITLE_CHARS, MAX_SUMMARY_CHARS,
  MAX_SEEN_IDS, MAX_ACTIVE_CLAIMS, MAX_SOURCES_PER_CLAIM, MAX_ERROR_CHARS, HTTP_TIMEOUT_MS,
  MAX_REDIRECTS, FRESHNESS_BOUND_MS, PACKET_MAX_CLAIMS, PACKET_MAX_SOURCES, PACKET_MAX_EVIDENCE,
  PACKET_MAX_CLAIM_LINKS, PACKET_MAX_CONTRADICTIONS, PACKET_MAX_MISSING, PACKET_MAX_RAW_CHARS,
  boundedError, COOLDOWN_LADDER_MS, MAX_COOLDOWN_MS, cooldownMs, RETRY_AFTER_MIN_MS,
  RETRY_AFTER_MAX_MS, boundedRetryAfterMs, canonicalJson, contentHash, sourceObservationIdentity,
  propositionIdentity, RUMOR2_CLAIM_TYPES, RUMOR2_TXN_EVENT_TYPES, emptyProviderState,
  emptyCheckpoint, rememberSeen, OBS_PER_CLAIM,
} from './truth-core.js';
export {
  APPROVED_COIN_ALIASES, AMBIGUOUS_TICKERS, buildCoinRegistry, resolveCoins,
  classifyOfficialItem, stripMarkup, itemClocks, PROVIDER_COVERAGE_STATES,
} from './truth-classify.js';
export { independenceGroupFor, emptyGraph, observeClaim, deriveTxnGraphDelta } from './truth-graph.js';
export {
  LEGACY_PRE_B1_PROVIDERS, MAX_ETAG_CHARS, MAX_LAST_MODIFIED_CHARS,
  validateRumor2Graph, validateRumor2Checkpoint,
} from './truth-validate.js';
export { validateRumor2Txn } from './truth-txn.js';
export { replayRumor2SettledTruth, validateRumor2EventHistory } from './truth-replay.js';
