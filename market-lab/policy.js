// MARKET LAB — research policy, subjects, and resource limits (§5, §11.3). Pure: no env read here; the CLI / composition
// hands in `env` when presence of a credential must be checked, and only PRESENCE is ever reported — no value leaves.
// The policy is separate from cobra.config.json and from the trading cost / ledger modules. Zero or absent paid
// authorization means NO paid call. Shipped defaults are disabled; an operator enables explicitly.
import { isPlainObject, isCount, isFiniteNum, isBoundedString, isStringOrNull, exactKeys, enumError, deepFreeze, canonicalDigest, PROVIDER_IDS, FAMILIES, isCoin, isId, isIdOrNull, isDateOnly, jsonShapeError, fail } from './contracts.js';
import { ENDPOINTS } from './registry.js';

export const POLICY_VERSION = 'market-research-policy-1';
export const SUBJECTS_VERSION = 'market-research-subjects-1';
export const MODES = Object.freeze(['LIVE_OBSERVATION', 'REPLAY_AS_OF']);
export const BILLING = Object.freeze(['FREE', 'INCLUDED_QUOTA', 'METERED', 'UNKNOWN']);
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MODEL_PROVIDERS = Object.freeze(['ANTHROPIC']);
export const APPROVED_MODEL_HOSTS = Object.freeze(['api.anthropic.com']);
export const DEFAULT_MODEL_ID = 'claude-sonnet-5';
export const MODEL_EFFORTS = Object.freeze(['low', 'medium', 'high']);

// §5 initial bounded defaults — engineering / resource limits, never trading rules
export const RESOURCE_DEFAULTS = deepFreeze({
  catalogMaxMarkets: 5_000, hotSubjects: 64, tradesPerHotSymbol: 50_000, hotStateBytes: 64 * 1024 * 1024,
  bookLevelsPerSide: 200, bookSampleMinIntervalMs: 500, bookSamplesTwoMinutes: 241, bookMinuteEndpoints: 180,
  barsPerInterval: 720, derivativesPerCase: 64, optionsAdmittedPerCase: 512, venueSnapshots: 16, onchainMetrics: 64, eventsPerCase: 128,
  intakeQueueItems: 1_024, intakeQueueBytes: 8 * 1024 * 1024, transportResponseBytes: 8 * 1024 * 1024,
  observationLineBytes: 128 * 1024, coverageLineBytes: 128 * 1024, packetLineBytes: 256 * 1024, manifestBytes: 1024 * 1024,
  segmentBytes: 32 * 1024 * 1024, runBytes: 1024 * 1024 * 1024, contextBytes: 2 * 1024 * 1024, researchRootQuotaBytes: 4 * 1024 * 1024 * 1024,
  httpConcurrencyGlobal: 4, httpConcurrencyPerProvider: 1, httpTimeoutMs: 15_000, wsIdleTimeoutMs: 30_000, maxPagesPerRequest: 20, maxRecordsPerRequest: 5_000,
});
export const CASE_DEFAULTS = deepFreeze({ maxConcurrentModelRequests: 1, maxPendingCases: 16, maxDataRequestsPerCase: 6, maxFollowupRounds: 1, maxModelAttempts: 2, attemptTimeoutMs: 90_000, caseTimeoutMs: 180_000, maxModelInputBytes: 262_144, maxModelOutputBytes: 65_536, maxOutputTokens: 8_192, requestCacheSize: 256 });
// allowed requestedMaxAgeMs values per family (a freshness REQUEST vocabulary; never a cadence change)
export const ALLOWED_MAX_AGE_MS = deepFreeze({
  SPOT_PRICE_CHART: [15_000, 60_000, 300_000, 3_600_000], SPOT_FLOW: [15_000, 60_000, 300_000], DISPLAYED_LIQUIDITY: [1_000, 15_000, 60_000], CROSS_VENUE: [15_000, 60_000, 300_000],
  DERIVATIVES_FUNDING_OI: [60_000, 300_000, 3_600_000], LIQUIDATIONS: [60_000, 300_000, 3_600_000], OPTIONS_TERM_SKEW: [300_000, 3_600_000], SUPPLY_UNLOCKS: [3_600_000, 86_400_000],
  DEX_DEFI: [300_000, 3_600_000, 86_400_000], ONCHAIN_ENTITY_FLOW: [3_600_000, 86_400_000], NETWORK_ACTIVITY: [3_600_000, 86_400_000], STABLECOIN_LIQUIDITY: [3_600_000, 86_400_000],
  ETF_FLOWS: [86_400_000], MACRO_RELEASES: [3_600_000, 86_400_000], CROSS_ASSET: [60_000, 3_600_000, 86_400_000], OFFICIAL_SOCIAL_EVENTS: [60_000, 3_600_000], INFRASTRUCTURE_STATUS: [60_000, 3_600_000],
});

const PROVIDER_POLICY_KEYS = ['enabled', 'credentialEnv', 'plan', 'limits', 'permittedEndpoints', 'smoke'];
const PLAN_KEYS = ['name', 'billing', 'includedCallsPerMonth', 'remainingCalls', 'incrementalUsdPerCall', 'attestation', 'verifiedDate', 'quoteUsdPerMonth'];
const LIMIT_KEYS = ['maxCallsPerDay', 'maxCallsPerMonth', 'maxConcurrency'];
const SMOKE_KEYS = ['authorized', 'maxCalls', 'maxEstimatedUsd'];
const MODEL_KEYS = ['enabled', 'provider', 'model', 'credentialEnv', 'apiHost', 'maxOutputTokens', 'maxEstimatedUsdPerCase', 'maxEstimatedUsdPerDay', 'maxEstimatedUsdPerMonth', 'totalSmokeMaxEstimatedUsd', 'attemptTimeoutMs', 'caseTimeoutMs', 'pricing', 'effort', 'pinnedPromptVersion'];
const PRICING_KEYS = ['inputUsdPerMTok', 'outputUsdPerMTok', 'cacheReadUsdPerMTok', 'cacheWriteUsdPerMTok', 'pricingSource', 'verifiedDate'];
export const POLICY_KEYS = Object.freeze(['policyVersion', 'mode', 'providers', 'model', 'resources', 'cases', 'retention']);
const RETENTION_KEYS = ['persistProviderText', 'onQuotaExhausted'];
export const QUOTA_EXHAUSTED_POLICIES = Object.freeze(['STOP_CAPTURE', 'ROTATE_OLDEST_UNSEALED']);

const nonNegOrNull = (v) => v === null || (isFiniteNum(v) && v >= 0);
export function policyError(raw, where = 'policy') {
  const shape = jsonShapeError(raw, where); if (shape) return shape;
  const k = exactKeys(raw, POLICY_KEYS, where); if (k) return k;
  if (raw.policyVersion !== POLICY_VERSION) return `${where}: unsupported policyVersion`;
  if (!MODES.includes(raw.mode)) return `${where}: mode outside vocabulary`;
  if (!isPlainObject(raw.providers)) return `${where}: providers must be an object`;
  const pkeys = Object.keys(raw.providers);
  for (let i = 0; i < pkeys.length; i += 1) {
    const id = pkeys[i]; if (!PROVIDER_IDS.includes(id)) return `${where}.providers: undeclared provider at position ${i + 1}`;
    const p = raw.providers[id]; const w = `${where}.providers.${id}`;
    const e = exactKeys(p, PROVIDER_POLICY_KEYS, w); if (e) return e;
    if (typeof p.enabled !== 'boolean') return `${w}: enabled must be boolean`;
    if (!(p.credentialEnv === null || (typeof p.credentialEnv === 'string' && ENV_NAME_RE.test(p.credentialEnv)))) return `${w}: credentialEnv must be an environment variable NAME or null`;
    const pe = exactKeys(p.plan, PLAN_KEYS, `${w}.plan`); if (pe) return pe;
    if (!isStringOrNull(p.plan.name, 64) || !BILLING.includes(p.plan.billing) || !(p.plan.includedCallsPerMonth === null || isCount(p.plan.includedCallsPerMonth)) || !(p.plan.remainingCalls === null || isCount(p.plan.remainingCalls)) || !nonNegOrNull(p.plan.incrementalUsdPerCall) || !isStringOrNull(p.plan.attestation, 300) || !(p.plan.verifiedDate === null || isDateOnly(p.plan.verifiedDate)) || !nonNegOrNull(p.plan.quoteUsdPerMonth)) return `${w}.plan: malformed`;
    const le = exactKeys(p.limits, LIMIT_KEYS, `${w}.limits`); if (le) return le;
    if (!isCount(p.limits.maxCallsPerDay) || !isCount(p.limits.maxCallsPerMonth) || !isCount(p.limits.maxConcurrency) || p.limits.maxConcurrency > 4) return `${w}.limits: malformed`;
    if (!(p.permittedEndpoints === null || (Array.isArray(p.permittedEndpoints) && p.permittedEndpoints.every((x) => isId(x) && ENDPOINTS.some((ep) => ep.providerId === id && ep.endpointId === x)) && new Set(p.permittedEndpoints).size === p.permittedEndpoints.length))) return `${w}.permittedEndpoints: must be null or registered endpoint ids of this provider`;
    const se = exactKeys(p.smoke, SMOKE_KEYS, `${w}.smoke`); if (se) return se;
    if (typeof p.smoke.authorized !== 'boolean' || !isCount(p.smoke.maxCalls) || !nonNegOrNull(p.smoke.maxEstimatedUsd)) return `${w}.smoke: malformed`;
    // a paid smoke needs a plan record establishing included calls + remaining quota + zero incremental charge, OR an explicit ceiling
    if (p.smoke.authorized && p.plan.billing === 'METERED' && !(isFiniteNum(p.smoke.maxEstimatedUsd) && p.smoke.maxEstimatedUsd > 0)) return `${w}.smoke: a metered smoke requires an explicit dollar ceiling`;
    if (p.smoke.authorized && p.plan.billing === 'INCLUDED_QUOTA' && !(isCount(p.plan.includedCallsPerMonth) && isCount(p.plan.remainingCalls) && p.plan.incrementalUsdPerCall === 0)) return `${w}.smoke: an included-quota smoke needs included calls, remaining quota and zero incremental charge on record`;
    if (p.smoke.authorized && p.plan.billing === 'UNKNOWN') return `${w}.smoke: unknown billing cannot authorize a smoke`;
  }
  const me = exactKeys(raw.model, MODEL_KEYS, `${where}.model`); if (me) return me;
  const m = raw.model;
  if (typeof m.enabled !== 'boolean' || !MODEL_PROVIDERS.includes(m.provider) || !isBoundedString(m.model, 64) || !/^[a-z0-9.-]+$/.test(m.model)) return `${where}.model: identity malformed`;
  if (!(typeof m.credentialEnv === 'string' && ENV_NAME_RE.test(m.credentialEnv))) return `${where}.model: credentialEnv must be an environment variable NAME`;
  if (!APPROVED_MODEL_HOSTS.includes(m.apiHost)) return `${where}.model: apiHost is not an approved host`;
  if (!isCount(m.maxOutputTokens) || m.maxOutputTokens < 256 || m.maxOutputTokens > CASE_DEFAULTS.maxOutputTokens) return `${where}.model: maxOutputTokens outside [256, ${CASE_DEFAULTS.maxOutputTokens}]`;
  for (const c of ['maxEstimatedUsdPerCase', 'maxEstimatedUsdPerDay', 'maxEstimatedUsdPerMonth', 'totalSmokeMaxEstimatedUsd']) if (!(isFiniteNum(m[c]) && m[c] >= 0)) return `${where}.model: ${c} must be a non-negative number (0 = no paid call)`;
  if (!isCount(m.attemptTimeoutMs) || m.attemptTimeoutMs < 1000 || m.attemptTimeoutMs > CASE_DEFAULTS.attemptTimeoutMs || !isCount(m.caseTimeoutMs) || m.caseTimeoutMs < m.attemptTimeoutMs || m.caseTimeoutMs > CASE_DEFAULTS.caseTimeoutMs) return `${where}.model: timeouts outside the ceilings`;
  const pr = exactKeys(m.pricing, PRICING_KEYS, `${where}.model.pricing`); if (pr) return pr;
  for (const c of ['inputUsdPerMTok', 'outputUsdPerMTok', 'cacheReadUsdPerMTok', 'cacheWriteUsdPerMTok']) if (!(isFiniteNum(m.pricing[c]) && m.pricing[c] >= 0)) return `${where}.model.pricing: ${c} malformed`;
  if (!isBoundedString(m.pricing.pricingSource, 200) || !isDateOnly(m.pricing.verifiedDate)) return `${where}.model.pricing: source/date malformed`;
  if (!(m.effort === null || MODEL_EFFORTS.includes(m.effort)) || !isIdOrNull(m.pinnedPromptVersion)) return `${where}.model: effort/prompt pin malformed`;
  const re = exactKeys(raw.resources, Object.keys(RESOURCE_DEFAULTS), `${where}.resources`); if (re) return re;
  for (const [key, def] of Object.entries(RESOURCE_DEFAULTS)) { const v = raw.resources[key]; if (!isCount(v) || v === 0) return `${where}.resources: ${key} must be a positive integer`; if (v > def) return `${where}.resources: ${key} exceeds the shipped ceiling ${def}`; }
  const ce = exactKeys(raw.cases, Object.keys(CASE_DEFAULTS), `${where}.cases`); if (ce) return ce;
  for (const [key, def] of Object.entries(CASE_DEFAULTS)) { const v = raw.cases[key]; if (!isCount(v) || v === 0) return `${where}.cases: ${key} must be a positive integer`; if (v > def) return `${where}.cases: ${key} exceeds the ceiling ${def}`; }
  const rt = exactKeys(raw.retention, RETENTION_KEYS, `${where}.retention`); if (rt) return rt;
  if (raw.retention.persistProviderText !== false) return `${where}.retention: provider free text is never persisted beyond bounded references (must be false)`;
  if (!QUOTA_EXHAUSTED_POLICIES.includes(raw.retention.onQuotaExhausted)) return `${where}.retention: onQuotaExhausted outside vocabulary`;
  return null;
}
export function validatePolicy(raw) { const e = policyError(raw); return e ? { ok: false, error: e, policy: null } : { ok: true, error: null, policy: deepFreeze(structuredClone(raw)) }; }
export const policyDigest = (policy) => canonicalDigest(policy);
export const loadPolicy = (raw) => { const r = validatePolicy(raw); if (!r.ok) fail('INVALID_INPUT', r.error); return r.policy; };

// credential PRESENCE per provider — reads env only through the NAMED variable; never returns the value
export function credentialPresence(policy, env = {}) {
  const out = {};
  for (const id of PROVIDER_IDS) {
    const p = policy.providers[id];
    const ep = ENDPOINTS.filter((e) => e.providerId === id);
    const needsAuth = ep.some((e) => e.authEnv !== null && e.authPlacement !== 'HEADER_OPTIONAL');
    const optionalAuth = !needsAuth && ep.some((e) => e.authEnv !== null);
    if (!p) { out[id] = { configured: false, access: needsAuth ? 'UNVERIFIED' : 'PUBLIC', credentialEnv: null }; continue; }
    if (!needsAuth && !optionalAuth) { out[id] = { configured: p.enabled, access: 'PUBLIC', credentialEnv: null }; continue; }
    const name = p.credentialEnv ?? ep.find((e) => e.authEnv)?.authEnv ?? null;
    const present = typeof name === 'string' && typeof env[name] === 'string' && env[name].length > 0;
    out[id] = { configured: p.enabled, access: present ? 'CONFIGURED' : optionalAuth ? 'PUBLIC' : 'CREDENTIAL_MISSING', credentialEnv: name };
  }
  const mname = policy.model.credentialEnv;
  out.MODEL = { configured: policy.model.enabled, access: typeof env[mname] === 'string' && env[mname].length > 0 ? 'CONFIGURED' : 'CREDENTIAL_MISSING', credentialEnv: mname };
  return deepFreeze(out);
}
export const providerEnabled = (policy, id) => policy.providers[id]?.enabled === true;
export const endpointPermitted = (policy, id, endpointId) => { const p = policy.providers[id]; if (!p || !p.enabled) return false; return p.permittedEndpoints === null || p.permittedEndpoints.includes(endpointId); };
export const paidCallAuthorized = (policy, id) => { const p = policy.providers[id]; if (!p || !p.enabled) return false; if (p.plan.billing === 'FREE') return true; if (p.plan.billing === 'INCLUDED_QUOTA') return isCount(p.plan.remainingCalls) && p.plan.remainingCalls > 0 && p.plan.incrementalUsdPerCall === 0; if (p.plan.billing === 'METERED') return p.smoke.authorized && isFiniteNum(p.smoke.maxEstimatedUsd) && p.smoke.maxEstimatedUsd > 0; return false; };

// ---- the shipped sample: every paid / model client disabled, public clients disabled too (explicit opt-in) --------
export function samplePolicy() {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const ep = ENDPOINTS.filter((e) => e.providerId === id);
    const authEnv = ep.find((e) => e.authEnv)?.authEnv ?? null;
    const billing = ep.every((e) => e.planRequirement === 'PUBLIC') ? 'FREE' : 'UNKNOWN';
    providers[id] = { enabled: false, credentialEnv: authEnv, plan: { name: null, billing, includedCallsPerMonth: null, remainingCalls: null, incrementalUsdPerCall: null, attestation: null, verifiedDate: null, quoteUsdPerMonth: null }, limits: { maxCallsPerDay: 1000, maxCallsPerMonth: 20000, maxConcurrency: 1 }, permittedEndpoints: null, smoke: { authorized: false, maxCalls: 0, maxEstimatedUsd: null } };
  }
  return deepFreeze({
    policyVersion: POLICY_VERSION, mode: 'LIVE_OBSERVATION', providers,
    model: { enabled: false, provider: 'ANTHROPIC', model: DEFAULT_MODEL_ID, credentialEnv: 'ANTHROPIC_API_KEY', apiHost: 'api.anthropic.com', maxOutputTokens: 4096, maxEstimatedUsdPerCase: 0, maxEstimatedUsdPerDay: 0, maxEstimatedUsdPerMonth: 0, totalSmokeMaxEstimatedUsd: 0, attemptTimeoutMs: 90_000, caseTimeoutMs: 180_000, pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5, pricingSource: 'https://www.anthropic.com/claude/sonnet', verifiedDate: '2026-09-08' }, effort: null, pinnedPromptVersion: null },
    resources: { ...RESOURCE_DEFAULTS }, cases: { ...CASE_DEFAULTS }, retention: { persistProviderText: false, onQuotaExhausted: 'STOP_CAPTURE' },
  });
}

// ---- subjects file ------------------------------------------------------------------------------------------------
export const SUBJECT_ENTRY_KEYS = Object.freeze(['canonicalCoin', 'krakenSpot', 'coinbase', 'krakenDerivatives', 'deribit', 'bybit', 'coingecko', 'tokens', 'pools', 'protocols', 'cryptoquant', 'santiment', 'coinmetrics', 'tokenomist', 'coinglass']);
export const SUBJECTS_KEYS = Object.freeze(['subjectsVersion', 'subjects', 'macroSeries', 'crossAsset', 'stablecoins', 'referenceNotionals', 'peers', 'benchmarks']);
export const MAX_SUBJECTS = 64;
export function subjectsError(raw, where = 'subjects') {
  const shape = jsonShapeError(raw, where); if (shape) return shape;
  const k = exactKeys(raw, SUBJECTS_KEYS, where); if (k) return k;
  if (raw.subjectsVersion !== SUBJECTS_VERSION) return `${where}: unsupported subjectsVersion`;
  if (!Array.isArray(raw.subjects) || raw.subjects.length === 0 || raw.subjects.length > MAX_SUBJECTS) return `${where}: subjects must hold 1..${MAX_SUBJECTS} entries`;
  const coins = new Set();
  for (let i = 0; i < raw.subjects.length; i += 1) {
    const s = raw.subjects[i]; const w = `${where}.subjects[${i}]`;
    const e = exactKeys(s, SUBJECT_ENTRY_KEYS, w); if (e) return e;
    if (!isCoin(s.canonicalCoin)) return `${w}: canonicalCoin malformed`;
    if (coins.has(s.canonicalCoin)) return `${w}: duplicate canonicalCoin`; coins.add(s.canonicalCoin);
    for (const f of ['krakenSpot', 'coinbase', 'krakenDerivatives', 'bybit', 'deribit', 'coingecko', 'cryptoquant', 'santiment', 'coinmetrics', 'tokenomist', 'coinglass']) if (!isIdOrNull(s[f])) return `${w}: ${f} must be a native identifier or null`;
    if (!Array.isArray(s.tokens) || s.tokens.length > 8 || s.tokens.some((t) => exactKeys(t, ['chain', 'contractAddress'], w) !== null || !isId(t.chain) || !isId(t.contractAddress))) return `${w}: tokens malformed`;
    if (!Array.isArray(s.pools) || s.pools.length > 8 || s.pools.some((p) => exactKeys(p, ['network', 'poolAddress'], w) !== null || !isId(p.network) || !isId(p.poolAddress))) return `${w}: pools malformed`;
    if (!Array.isArray(s.protocols) || s.protocols.length > 8 || s.protocols.some((p) => !isId(p))) return `${w}: protocols malformed`;
  }
  if (!Array.isArray(raw.macroSeries) || raw.macroSeries.length > 16 || raw.macroSeries.some((x) => !isId(x))) return `${where}: macroSeries malformed`;
  if (!Array.isArray(raw.crossAsset) || raw.crossAsset.length > 16 || raw.crossAsset.some((x) => exactKeys(x, ['symbol', 'exchange', 'proxyFor'], where) !== null || !isId(x.symbol) || !isIdOrNull(x.exchange) || !isBoundedString(x.proxyFor, 80))) return `${where}: crossAsset malformed (every instrument names what it is a proxy for)`;
  if (!Array.isArray(raw.stablecoins) || raw.stablecoins.length > 8 || raw.stablecoins.some((x) => exactKeys(x, ['stablecoinId', 'pegCurrency', 'defillamaId'], where) !== null || !isId(x.stablecoinId) || !isId(x.pegCurrency) || !isIdOrNull(x.defillamaId))) return `${where}: stablecoins malformed`;
  if (!Array.isArray(raw.referenceNotionals) || raw.referenceNotionals.length === 0 || raw.referenceNotionals.length > 8 || raw.referenceNotionals.some((n) => !(isFiniteNum(n) && n > 0)) || new Set(raw.referenceNotionals).size !== raw.referenceNotionals.length) return `${where}: referenceNotionals must be 1..8 distinct positive quote amounts`;
  if (!Array.isArray(raw.peers) || raw.peers.length > 64 || raw.peers.some((c) => !isCoin(c)) || new Set(raw.peers).size !== raw.peers.length) return `${where}: peers malformed`;
  if (!Array.isArray(raw.benchmarks) || raw.benchmarks.length > 8 || raw.benchmarks.some((c) => !isCoin(c))) return `${where}: benchmarks malformed`;
  return null;
}
export const loadSubjects = (raw) => { const e = subjectsError(raw); if (e) fail('INVALID_INPUT', e); return deepFreeze(structuredClone(raw)); };
export function sampleSubjects() {
  return deepFreeze({
    subjectsVersion: SUBJECTS_VERSION,
    subjects: [
      { canonicalCoin: 'BTC', krakenSpot: 'BTC/USD', coinbase: 'BTC-USD', krakenDerivatives: 'PF_XBTUSD', deribit: 'BTC', bybit: 'BTCUSDT', coingecko: 'bitcoin', tokens: [], pools: [], protocols: [], cryptoquant: 'btc', santiment: 'bitcoin', coinmetrics: 'btc', tokenomist: null, coinglass: 'BTC' },
      { canonicalCoin: 'ETH', krakenSpot: 'ETH/USD', coinbase: 'ETH-USD', krakenDerivatives: 'PF_ETHUSD', deribit: 'ETH', bybit: 'ETHUSDT', coingecko: 'ethereum', tokens: [], pools: [{ network: 'eth', poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' }], protocols: ['aave'], cryptoquant: 'eth', santiment: 'ethereum', coinmetrics: 'eth', tokenomist: null, coinglass: 'ETH' },
      { canonicalCoin: 'SOL', krakenSpot: 'SOL/USD', coinbase: 'SOL-USD', krakenDerivatives: 'PF_SOLUSD', deribit: null, bybit: 'SOLUSDT', coingecko: 'solana', tokens: [], pools: [], protocols: [], cryptoquant: null, santiment: 'solana', coinmetrics: 'sol', tokenomist: 'solana', coinglass: 'SOL' },
    ],
    macroSeries: ['DFF', 'DGS2', 'DGS10', 'DTWEXBGS', 'CPIAUCSL', 'UNRATE', 'WALCL', 'RRPONTSYD'],
    crossAsset: [{ symbol: 'SPY', exchange: null, proxyFor: 'broad US equity benchmark ETF proxy' }, { symbol: 'QQQ', exchange: null, proxyFor: 'technology benchmark ETF proxy' }, { symbol: 'TLT', exchange: null, proxyFor: 'long Treasury bond ETF proxy (not a cash yield)' }, { symbol: 'EUR/USD', exchange: null, proxyFor: 'dollar pair proxy (not DXY)' }, { symbol: 'XAU/USD', exchange: null, proxyFor: 'gold spot proxy' }],
    stablecoins: [{ stablecoinId: 'USDT', pegCurrency: 'USD', defillamaId: '1' }, { stablecoinId: 'USDC', pegCurrency: 'USD', defillamaId: '2' }],
    referenceNotionals: [1000, 10000, 100000],
    peers: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX'],
    benchmarks: ['BTC', 'ETH'],
  });
}
