// SERPENT PAPER — the 56-row REQUESTED SENSOR SCOPE (owner ticket of 2026-09-12), mapped onto the repository's own sensor
// inventory (paper/inventory.js). Fifty-six scope rows are NOT fifty-six external providers: a row names a requested
// capability; `inventoryIds` names the inventory row(s) that carry its code, composition, credentials and blocker facts.
// A row whose inventory rows are all NOT_PRESENT is a capability the repository does not implement — it stays in the
// scope, named, with its blocker, and is never dropped because it is blocked. Read-only, no network, no runtime effect.
export const SCOPE_VERSION = 'serpent-sensor-scope-1';
const R = (id, label, inventoryIds, note = null) => Object.freeze({ id, label, inventoryIds: Object.freeze(inventoryIds), note });
export const SCOPE = Object.freeze([
  // MARKET AND FINANCIAL — 20
  R('M01', 'Kraken public L2 books and depth (initial snapshot + ongoing synchronization)', ['TAPE'], 'the execution feed obtains a REAL venue snapshot for a symbol admitted after the subscription (2026-09-12 repair)'),
  R('M02', 'Kraken public trades and subscription / coverage state', ['TAPE']),
  R('M03', 'Kraken candles / configured price history', ['KRAKEN_OHLC_HISTORY']),
  R('M04', 'Kraken ticker, instruments and precision metadata', ['TAPE', 'KRAKEN_SPOT'], 'instrument precision is kept for every announced pair (2026-09-12 repair)'),
  R('M05', 'Kraken derivatives / futures ticker and configured funding', ['KRAKEN_DERIVATIVES']),
  R('M06', 'Kraken Futures Charts historical / open-interest observations', ['KRAKEN_CHARTS_DARK']),
  R('M07', 'Kraken Level 3 (separately permissioned, data-only; never a substitute for M01)', ['KRAKEN_L3_DARK']),
  R('M08', 'Coinbase spot market, trade, book and candle capabilities', ['COINBASE_SPOT']),
  R('M09', 'Deribit futures / options catalog and market observations', ['DERIBIT']),
  R('M10', 'Bybit public market observations (geographic eligibility)', ['BYBIT']),
  R('M11', 'CoinGecko Demo catalog / market / detail capabilities', ['COINGECKO']),
  R('M12', 'GeckoTerminal DEX / pool observations', ['GECKOTERMINAL']),
  R('M13', 'DefiLlama TVL, fee and stablecoin observations', ['DEFILLAMA']),
  R('M14', 'CoinMetrics Community asset metrics / history', ['COINMETRICS']),
  R('M15', 'FRED and ALFRED series + historical vintages (revised vs then-known preserved)', ['FRED'], 'market-lab/providers/fred.js keeps realtime_start / realtime_end per observation and exposes vintage dates'),
  R('M16', 'CoinGlass derivatives, liquidation, event / unlock and headline capabilities (each verified separately)', ['COINGLASS'], 'endpoints: oi-exchange-list, funding-exchange-list, liquidation-aggregated-history, coin-unlock-list, coin-vesting, economic-data, article-list'),
  R('M17', 'CryptoQuant on-chain / exchange metrics', ['CRYPTOQUANT']),
  R('M18', 'Santiment metrics / history', ['SANTIMENT']),
  R('M19', 'Twelve Data cross-asset / history', ['TWELVEDATA']),
  R('M20', 'Tokenomist unlock events', ['TOKENOMIST']),
  // SOCIAL — 10
  R('S01', 'Bluesky Jetstream', ['BLUESKY_OFFICIAL']),
  R('S02', 'X / Twitter configured collection', ['X_OFFICIAL']),
  R('S03', 'Legacy StockTwits aggregate route', ['RUMINT_STOCKTWITS_AGGREGATE']),
  R('S04', 'Official / raw StockTwits route (separate entitlement)', ['STOCKTWITS_OFFICIAL']),
  R('S05', 'Reddit', ['REDDIT_OFFICIAL']),
  R('S06', 'TikTok', ['TIKTOK_PUBLIC', 'TIKTOK_REALTIME_TRANSPORT']),
  R('S07', 'Meta / Facebook', ['META_PUBLIC', 'META_REALTIME_TRANSPORT'], 'FACEBOOK namespace of rumor2/social-meta.js'),
  R('S08', 'Meta / Instagram', ['META_PUBLIC', 'META_REALTIME_TRANSPORT'], 'INSTAGRAM namespace of rumor2/social-meta.js (documented routes M3-M6M; hashtag search needs App Review)'),
  R('S09', 'Farcaster / Neynar', ['FARCASTER_OFFICIAL', 'FARCASTER_LIVE_TRANSPORT']),
  R('S10', 'YouTube', ['YOUTUBE_DATA_API']),
  // OFFICIAL AND NEWS — 6
  R('N01', 'Kraken official announcements / news', ['KRAKEN_OFFICIAL']),
  R('N02', 'SEC press releases', ['SEC_OFFICIAL']),
  R('N03', 'CFTC press releases', ['CFTC_OFFICIAL']),
  R('N04', 'SEC EDGAR filings for the configured issuer / watchlist scope', ['EDGAR_OFFICIAL']),
  R('N05', 'OFAC sanctions updates (identity / diff semantics)', ['OFAC_OFFICIAL']),
  R('N06', 'CoinGlass headlines (linked to M16; not a second poller)', ['COINGLASS'], 'the article-list endpoint of the SAME CoinGlass client and quota accounting'),
  // PUBLISHER / NEWS CONNECTIONS — 9
  R('P01', 'Reuters', ['REUTERS_NEWS']),
  R('P02', 'Bloomberg', ['BLOOMBERG_NEWS']),
  R('P03', 'CNBC', ['CNBC_NEWS']),
  R('P04', 'Financial Times', ['FT_NEWS']),
  R('P05', 'CoinDesk', ['COINDESK_NEWS']),
  R('P06', 'The Block', ['THEBLOCK_NEWS']),
  R('P07', 'Cointelegraph', ['COINTELEGRAPH_NEWS']),
  R('P08', 'Decrypt', ['DECRYPT_NEWS']),
  R('P09', 'Google News (aggregator; transport identity is Google, publisher identity is per item)', ['GOOGLE_NEWS_AGGREGATOR']),
  // INFRASTRUCTURE, GOVERNANCE AND STATUS — 8
  R('I01', 'Cloudflare Radar (verified current authentication requirements)', ['CLOUDFLARE_RADAR']),
  R('I02', 'NOAA space weather (K-index / storm scales; experimental)', ['NOAA_SWPC_SPACE_WEATHER']),
  R('I03', 'RIPE RIS / BGP (bounded supported route)', ['RIPE_RIS_BGP']),
  R('I04', 'Tally governance (configured entities / proposals; event and knowledge clocks)', ['GOVERNANCE_TALLY']),
  R('I05', 'Kraken Statuspage', ['GATEWAY_KRAKEN_STATUS']),
  R('I06', 'Kraken system-status API', ['GATEWAY_KRAKEN_SYSTEM']),
  R('I07', 'Coinbase service status', ['GATEWAY_COINBASE_STATUS']),
  R('I08', 'OKX service status', ['GATEWAY_OKX_STATUS']),
  // INTERNAL CAPABILITIES TO PRESERVE — 3
  R('C01', 'WideEye market scanning', ['WIDEEYE']),
  R('C02', 'Universe coverage and selection', ['UNIVERSE_EXPANSION']),
  R('C03', 'Historical capture / replay and its point-in-time boundaries', ['HISTORICAL_CAPTURE_REPLAY']),
]);
export const SCOPE_IDS = Object.freeze(SCOPE.map((r) => r.id));
// the scope joined to the inventory: one object per scope row carrying the inventory rows it maps to (read-only)
export function scopeInventory(inventory) { const byId = new Map(inventory.rows.map((r) => [r.id, r])); return SCOPE.map((s) => ({ ...s, rows: s.inventoryIds.map((id) => byId.get(id) ?? null) })); }
