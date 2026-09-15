// MARKET LAB — shared closed contracts for real market observations (market-observation-1).
//
// This module is PURE: no network, no filesystem, no clock, no configuration, no model. It defines
// (1) the strict input boundary (UTF-8 / JSON / duplicate keys / unsafe numbers / prototype hazards),
// (2) the ONE normalized observation envelope every provider client emits, with a closed discriminated
//     subject identity and a closed typed payload per kind,
// (3) the closed vocabularies (families, kinds, quality states, reason codes, units) and the metric registry
//     the broker, the recipes and the evidence builder all validate against.
// Laws: unknown keys fail at every depth; missing / failed / unsupported data carries null, never zero; a
// diagnostic never echoes raw provider text, property names or credentials — positions and closed reasons only.
// This module is a thin BARREL: the implementation lives in the sibling contracts-*.js modules.
export * from './contracts-core.js';
export * from './contracts-registry.js';
export * from './contracts-subject.js';
export * from './contracts-payload.js';
export * from './contracts-observation.js';
export * from './contracts-coverage.js';
