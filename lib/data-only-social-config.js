// DATA-ONLY composition policy for the bounded X commissioning smoke.
// This selects a paid watch only; the Rumor2 resolver still requires a fresh,
// accepted catalog and admits only tickers verified in that catalog.
export const DATA_ONLY_X_WATCH = Object.freeze({
  mode: 'EXPLICIT_STATIC',
  tickers: Object.freeze(['BTC', 'ETH', 'SOL']),
  maxAssets: 3,
});

export function composeDataOnlySocialConfig(config, universe) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('data-only config must be an object');
  if (!Array.isArray(universe)) throw new Error('data-only universe must be an array');
  return {
    ...config,
    universe: [...universe],
    socialResearch: {
      ...config.socialResearch,
      xWatch: {
        ...config.socialResearch?.xWatch,
        ...DATA_ONLY_X_WATCH,
        tickers: [...DATA_ONLY_X_WATCH.tickers],
      },
    },
  };
}
