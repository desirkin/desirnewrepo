// SERPENT PAPER PROFILE — the ONE checked-in, secret-free runtime profile (config/paper-runtime.json) and its closed law.
// The profile says what the paper system WANTS ON (desiredState per sense) and how a blocker is treated (blockerPolicy);
// the runtime, the preflight and the cockpit all read this file, so an operator never rediscovers the composition from
// scattered env flags. Laws enforced here:
//  * runtimeMode / judge mode are PAPER and can never be LIVE; JUDGE_ALLOW_PRIVATE / JUDGE_ALLOW_ORDERS are forced false;
//  * the profile derives the NON-SECRET enable environment (RUMOR2_*, MARKET_RESEARCH_*, JUDGE_*) — it never carries a
//    secret value and never copies one; secrets stay in the operator's own environment under the documented NAMES;
//  * a credential present in the environment is never an enable: REQUEST senses activate only through their own gate.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/config.js';

export const PROFILE_VERSION = 'serpent-paper-profile-1';
export const PROFILE_ENV = 'COBRA_PROFILE';
export const DEFAULT_PROFILE_FILE = 'config/paper-runtime.json';
export const DESIRED_STATES = Object.freeze(['ON', 'REQUEST', 'OFF']);
export const BLOCKER_POLICIES = Object.freeze(['BLOCK_PAPER', 'DEGRADE', 'PAID_GATE', 'DARK_RESEARCH']);
export const PROFILE_GROUPS = Object.freeze(['coreObservation', 'infrastructure', 'rumorOfficial', 'social', 'marketResearch', 'darkEdgeCapture', 'socrates', 'judge', 'watch', 'persistence', 'cockpit', 'publisherNews']);
export const RUNTIME_STATES = Object.freeze(['ACTIVE', 'ACTIVE_DEGRADED', 'BLOCKED_CREDENTIAL', 'BLOCKED_BUDGET', 'BLOCKED_EXTERNAL_APPROVAL', 'BLOCKED_TERMS', 'BLOCKED_RETENTION', 'BLOCKED_GEOGRAPHY', 'BLOCKED_PROVIDER', 'FOUNDATION_ONLY', 'DISABLED_BY_PAPER_POLICY']);
// names the launcher FORCES (never read from the operator environment) — the paper profile's non-negotiable authority law
export const FORCED_ENV = Object.freeze({ JUDGE_MODE: 'PAPER', JUDGE_ALLOW_PRIVATE: 'false', JUDGE_ALLOW_ORDERS: 'false', RUMOR2_SOCIAL_MODE: 'LIVE' });
export const SECRET_ENV_NAMES = Object.freeze(['SERPENT_CONTROL_PASSWORD', 'DATABASE_URL', 'X_BEARER_TOKEN', 'FRED_API_KEY', 'COINGECKO_DEMO_API_KEY', 'COINGLASS_API_KEY', 'CRYPTOQUANT_API_KEY', 'SANTIMENT_API_KEY', 'TWELVEDATA_API_KEY', 'TOKENOMIST_API_KEY', 'ANTHROPIC_API_KEY', 'KRAKEN_L3_DATA_API_KEY', 'KRAKEN_L3_DATA_API_SECRET', 'JUDGE_OWNER_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'YOUTUBE_API_KEY']);
const VALUE_LIKE = /sk-ant|sk_live|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\/[^<\s]+:[^<\s]+@/i;

export class ProfileError extends Error { constructor(message) { super(message); this.code = 'PROFILE_INVALID'; } }
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowError = (row, where) => {
  if (!plain(row)) return `${where}: row must be an object`;
  if (!DESIRED_STATES.includes(row.desiredState)) return `${where}: desiredState must be ON | REQUEST | OFF`;
  if (!BLOCKER_POLICIES.includes(row.blockerPolicy)) return `${where}: blockerPolicy must be one of ${BLOCKER_POLICIES.join(' | ')}`;
  if (row.desiredState === 'OFF' && !(typeof row.reason === 'string' && row.reason.length)) return `${where}: an OFF row names its reason`;
  if (row.desiredState === 'REQUEST' && !(row.credentialEnv || row.gate)) return `${where}: a REQUEST row names its gate (credentialEnv or gate)`;
  return null;
};
export function profileError(p) {
  if (!plain(p)) return 'profile must be an object';
  if (p.profileVersion !== PROFILE_VERSION) return `profileVersion must be ${PROFILE_VERSION}`;
  if (p.runtimeMode !== 'PAPER') return 'runtimeMode must be PAPER (this profile can never be LIVE)';
  const a = p.authority; if (!plain(a)) return 'authority block required';
  if (a.realMoney !== 'DISABLED' || a.liveOrders !== 'DISABLED' || a.withdrawFunding !== 'DISABLED') return 'authority: realMoney / liveOrders / withdrawFunding must be DISABLED';
  if (a.judgeMode !== 'PAPER' || a.judgeAllowPrivate !== false || a.judgeAllowOrders !== false) return 'authority: judgeMode PAPER with allowPrivate / allowOrders false';
  if (a.darkSensesDecisionAuthority !== 'NONE') return 'authority: dark senses carry no decision authority';
  if (!plain(p.files) || !['marketResearchPolicy', 'marketResearchSubjects', 'judgePolicy'].every((k) => typeof p.files[k] === 'string' && p.files[k].length && !path.isAbsolute(p.files[k]) && !p.files[k].includes('..'))) return 'files: policy / subjects / judge policy must be repo-relative paths';
  if (!plain(p.groups) || Object.keys(p.groups).join('|') !== PROFILE_GROUPS.join('|')) return `groups must be exactly ${PROFILE_GROUPS.join(', ')}`;
  for (const g of PROFILE_GROUPS) { const grp = p.groups[g]; if (!plain(grp) || !Object.keys(grp).length) return `groups.${g}: at least one row`; for (const [k, row] of Object.entries(grp)) { if (g === 'marketResearch' && k === 'providers') { if (!plain(row) || !Object.keys(row).length) return 'marketResearch.providers must be an object'; for (const [pid, pr] of Object.entries(row)) { const e = rowError(pr, `marketResearch.providers.${pid}`); if (e) return e; } continue; } const e = rowError(row, `${g}.${k}`); if (e) return e; } }
  const j = p.groups.judge.judge; if (j.mode !== 'PAPER' || j.desiredState !== 'ON' || j.blockerPolicy !== 'BLOCK_PAPER') return 'groups.judge.judge must be ON / BLOCK_PAPER / mode PAPER';
  if (p.groups.persistence.localJournalFallback?.desiredState !== 'OFF') return 'persistence.localJournalFallback must be OFF (never a silent fallback)';
  if (p.groups.darkEdgeCapture.krakenL3?.gate !== 'SAFE_L3_DATA_KEY' || p.groups.darkEdgeCapture.krakenL3?.blockedVerdict !== 'BLOCKED_NO_SAFE_L3_DATA_KEY') return 'darkEdgeCapture.krakenL3 must gate on SAFE_L3_DATA_KEY';
  if (plain(p.configOverlay)) { for (const k of Object.keys(p.configOverlay)) if (['locks', 'paper', 'fees', 'cost'].includes(k)) return `configOverlay may not touch ${k} (no threshold / fee / risk change through a profile)`; }
  const text = JSON.stringify(p); if (VALUE_LIKE.test(text)) return 'the profile carries a value-like secret';
  for (const name of SECRET_ENV_NAMES) if (new RegExp(`"${name}"\\s*:\\s*"[^"<]`).test(text)) return `the profile assigns a value to the secret name ${name}`;
  return null;
}
export function loadProfile(file = process.env[PROFILE_ENV] ?? DEFAULT_PROFILE_FILE, { root = repoRoot() } = {}) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  let raw; try { raw = JSON.parse(readFileSync(abs, 'utf8')); } catch (err) { throw new ProfileError(`profile ${file}: ${err.code ?? err.constructor.name}: ${String(err.message).slice(0, 120)}`); }
  const e = profileError(raw); if (e) throw new ProfileError(`profile ${file}: ${e}`);
  return Object.freeze({ ...raw, file, absFile: abs, root });
}
export const profileFileOf = (profile, key) => path.join(profile.root, profile.files[key]);
// the NON-SECRET environment the profile implies (enables, file paths, forced authority values). Values only for booleans and
// repo paths; every credential stays under the operator's own NAME and is never touched here.
export function profileEnvironment(profile, { dataDir = null } = {}) {
  const g = profile.groups; const on = (row) => row?.desiredState === 'ON';
  const env = {
    [PROFILE_ENV]: profile.file,
    ...FORCED_ENV,
    JUDGE_ENABLED: on(g.judge.judge) ? 'true' : 'false', JUDGE_POLICY: profileFileOf(profile, 'judgePolicy'), JUDGE_ACCOUNT: g.judge.judge.accountId ?? '',
    MARKET_RESEARCH_ENABLED: on(g.marketResearch.service) ? 'true' : 'false', MARKET_RESEARCH_POLICY: profileFileOf(profile, 'marketResearchPolicy'), MARKET_RESEARCH_SUBJECTS: profileFileOf(profile, 'marketResearchSubjects'),
    RUMOR2_ENABLED: on(g.rumorOfficial.rumor2) ? 'true' : 'false', RUMOR2_EDGAR_ENABLED: on(g.rumorOfficial.EDGAR_OFFICIAL) ? 'true' : 'false', RUMOR2_OFAC_ENABLED: on(g.rumorOfficial.OFAC_OFFICIAL) ? 'true' : 'false',
    RUMOR2_ALLOW_LOCAL_JOURNAL: on(g.persistence.localJournalFallback) ? 'true' : 'false',
    RUMOR2_SOCIAL_BLUESKY_ENABLED: on(g.social.BLUESKY_OFFICIAL) ? 'true' : 'false',
    // X: the profile REQUESTS it; the existing governor decides (credential -> budgets -> paid smoke). The enable flag alone
    // never spends: without a bearer / budget the runtime stays CREDENTIAL_MISSING / BUDGET_NOT_CONFIGURED.
    RUMOR2_SOCIAL_X_ENABLED: g.social.X_OFFICIAL?.desiredState === 'REQUEST' || on(g.social.X_OFFICIAL) ? 'true' : 'false',
    WIDEEYE_ENABLED: on(g.coreObservation.wideEye) ? 'true' : 'false', GATEWAY_ENABLED: on(g.infrastructure.gateway) ? 'true' : 'false', RUMINT_ENABLED: on(g.rumorOfficial.rumintLegacy) ? 'true' : 'false',
    // PUBLISHER observation tier (press/): the profile selects publisher feeds by id; ON rows are watched, OFF / licensed rows
    // never called. Headline / link only, authority NONE, outside the frozen RUMOR-2 evidence core.
    PRESS_ENABLED: Object.values(g.publisherNews).some(on) ? 'true' : 'false', PRESS_SOURCES: Object.entries(g.publisherNews).filter(([, r]) => on(r)).map(([id]) => id).join(','),
    // INFRASTRUCTURE observation tier (infra/): NOAA / RIPE RIS / Cloudflare Radar. REQUEST rows are selected but the collector's
    // own gate decides (CONFIG_REQUIRED / CREDENTIAL_REQUIRED make zero calls); a credential alone never enables anything.
    INFRA_OBS_ENABLED: Object.entries(g.infrastructure).some(([id, r]) => id !== 'gateway' && (on(r) || r?.desiredState === 'REQUEST')) ? 'true' : 'false',
    // SOCIAL VIDEO (video/): REQUESTED like X — the collector's own closed gate decides (key + own queries + explicit daily
    // search budget); the enable flag alone never spends a request.
    SOCIAL_VIDEO_ENABLED: g.social.YOUTUBE_DATA_API?.desiredState === 'REQUEST' || on(g.social.YOUTUBE_DATA_API) ? 'true' : 'false',
    INFRA_SOURCES: Object.entries(g.infrastructure).filter(([id, r]) => id !== 'gateway' && (on(r) || r?.desiredState === 'REQUEST')).map(([id]) => id).join(','),
  };
  if (dataDir) env.COBRA_DATA_DIR = dataDir;
  if (typeof g.judge.judge.accountId !== 'string' || !g.judge.judge.accountId.length) delete env.JUDGE_ACCOUNT;
  return Object.freeze(env);
}
// apply the profile to a live environment object: forced names ALWAYS win (an accidental JUDGE_MODE=LIVE_ARMED or
// JUDGE_ALLOW_ORDERS=true in the operator environment is overwritten and reported), derived names are set, secrets untouched
export function applyProfileEnvironment(profile, env = process.env, { dataDir = null } = {}) {
  const derived = profileEnvironment(profile, { dataDir }); const overridden = [];
  for (const [k, v] of Object.entries(derived)) { if (k in FORCED_ENV && env[k] !== undefined && env[k] !== v) overridden.push({ name: k, was: k === 'JUDGE_MODE' ? env[k] : '<value>', now: v }); env[k] = v; }
  return Object.freeze({ applied: Object.keys(derived), overridden });
}
// the exact authority lines every operator surface prints (preflight, launch): one fact per line, never joined
export const authorityLines = (paperMode) => Object.freeze(['REAL MONEY: DISABLED', 'LIVE ORDERS: DISABLED', 'WITHDRAW/FUNDING: DISABLED', `PAPER MODE: ${paperMode}`, 'DARK KRAKEN JUDGE AUTHORITY: NONE', 'DARK KRAKEN SOCRATES AUTHORITY: NONE', 'THRESHOLD CHANGES: NONE']);
export const secretPresence = (profile, env = process.env) => Object.freeze(Object.fromEntries(SECRET_ENV_NAMES.map((n) => [n, typeof env[n] === 'string' && env[n].length > 0])));
// deep-merge the profile's config overlay onto cobra.config.json (lib/config.js applies it when COBRA_PROFILE is set)
export function mergeOverlay(base, overlay) { if (!plain(overlay)) return base; const out = { ...base }; for (const [k, v] of Object.entries(overlay)) out[k] = plain(v) && plain(base?.[k]) ? mergeOverlay(base[k], v) : v; return out; }
