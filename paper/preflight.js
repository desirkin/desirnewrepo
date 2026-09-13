// SERPENT PAPER — the ONE preflight: "can the whole system run PAPER now?" in one bounded, READ-ONLY report (sections A..L).
// Zero paid calls. Without --smoke it touches no network at all; with --smoke it performs only the read-only public /
// entitlement probes the market-research policy already authorizes (the R01 dispatch guard, PROBE purpose, FREE providers)
// plus the read-only Kraken L3 key-permission probe and one public charts poll. Nothing here starts a collector, opens a
// socket for data, takes a writer lock, initializes an account, or prints a secret value (NAMES + presence only).
// Blockers are grouped: CORE_CODE_BLOCKER | CORE_RUNTIME_BLOCKER | EXTERNAL_OPTIONAL_SENSE_BLOCKER | PAID_SENSE_NOT_AUTHORIZED |
// DARK_RESEARCH_BLOCKER. READY_FOR_PAPER is false on ANY core blocker; an optional / paid / dark blocker never hides a ready core.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, dataDir as dataDirOf, repoRoot } from '../lib/config.js';
import { readControls } from '../state/controls.js';
import { dailyLockStatus } from '../state/locks.js';
import { durabilityRequired } from '../persistence/health.js';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { readPolicyFile, readSubjectsFile, runCoverage } from '../market-lab/commands.js';
import { policyDigest, credentialPresence, l3Policy, chartsPolicy } from '../market-lab/policy.js';
import { codeIdentity } from '../market-lab/identity.js';
import { marketResearchRootFromEnv } from '../market-lab/paths.js';
import { loadProfile, profileEnvironment, profileFileOf, secretPresence, FORCED_ENV, authorityLines } from './profile.js';
import { sensorSnapshot, snapshotRow, readJsonBounded, xGovernorState } from './readiness.js';

export const PREFLIGHT_VERSION = 'serpent-paper-preflight-1';
export const BLOCKER_GROUPS = Object.freeze(['CORE_CODE_BLOCKER', 'CORE_RUNTIME_BLOCKER', 'EXTERNAL_OPTIONAL_SENSE_BLOCKER', 'PAID_SENSE_NOT_AUTHORIZED', 'DARK_RESEARCH_BLOCKER']);
export const SECTIONS = Object.freeze(['A_CODE', 'B_STORAGE', 'C_CORE_MARKET', 'D_RUMOR_OFFICIAL', 'E_SOCIAL', 'F_MARKET_RESEARCH', 'G_DARK_EDGE_CAPTURE', 'H_SOCRATES', 'I_JUDGE', 'J_WATCH', 'K_CONTROLS', 'L_FINAL']);
const git = (root, args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; } };
const present = (env, names) => (Array.isArray(names) ? names : [names]).filter(Boolean).every((n) => typeof env[n] === 'string' && env[n].length > 0);
const bounded = (v) => String(v ?? '').slice(0, 200);
const storageCheckFailure = (name, err) => {
  const code = typeof err?.code === 'string' && /^(?:[0-9A-Z]{5}|INVALID_RESULT)$/.test(err.code) ? err.code : 'CHECK_FAILED';
  return `${name} could not be verified (${code}); PAPER readiness is blocked`;
};
const invalidStorageResult = () => Object.assign(new Error('invalid storage check result'), { code: 'INVALID_RESULT' });
const NO_SECRET = /sk-ant|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\/[^\s"]+:[^\s"]+@|API-Key|API-Sign|x-api-key|nonce=\d/i;

// A FAILED probe must say WHY, in the operator's report, not only in the matrix file: an authentication refusal, a parse
// failure, a timeout or an unavailable feed that arrives here as a bare PROBED_FAILED with a null reason is a failure
// masquerading as "nothing happened". The probe layer records the failure kind / reason code / coverage state / HTTP
// status; those facts are carried through verbatim and a reason is derived from them when the layer left it unset. The
// positive side is kept too — a PROBED_OK carrying count 0 is a SUCCESSFUL EMPTY response, never a failed collection.
export function probeFacts(probe) {
  if (!probe || typeof probe !== 'object') return null;
  const f = probe.failure && typeof probe.failure === 'object' ? probe.failure : null;
  const derived = f ? [f.kind ?? null, f.reasonCode ?? null, f.status === null || f.status === undefined ? null : `HTTP ${f.status}`, f.reason ?? null].filter(Boolean).join(':') : null;
  return {
    state: probe.state ?? null,
    reason: probe.reason ?? (derived || null),
    receivedTs: probe.receivedTs ?? probe.ts ?? null,
    endpointId: probe.endpointId ?? null,
    count: probe.count === undefined ? null : probe.count,
    requestId: probe.requestId ?? null,
    failure: f ? { kind: f.kind ?? null, reasonCode: f.reasonCode ?? null, coverageState: f.coverageState ?? null, status: f.status ?? null, reason: f.reason ?? null } : null,
  };
}
export async function runPreflight({ profileFile = process.env.COBRA_PROFILE ?? 'config/paper-runtime.json', env = process.env, smoke = false, now = () => Date.now(), log = () => {}, dbFactory = null, fetchImpl = globalThis.fetch } = {}) {
  const startedTs = now(); const blockers = Object.fromEntries(BLOCKER_GROUPS.map((g) => [g, []])); const warnings = [];
  const block = (group, id, reason, remedy = null) => blockers[group].push({ id, reason: bounded(reason), remedy: remedy ? bounded(remedy) : null });
  const sections = {};
  // the profile is the FIRST thing: without a valid PAPER profile nothing else is meaningful
  let profile; try { profile = loadProfile(profileFile); } catch (err) { block('CORE_CODE_BLOCKER', 'PROFILE', err.message, 'fix config/paper-runtime.json (runtimeMode PAPER, closed groups)'); return finish({ startedTs, now, profile: null, sections, blockers, warnings, smoke, env }); }
  // the effective environment = operator env + the profile's derived NON-SECRET enables (forced authority names always win)
  const derived = profileEnvironment(profile); const eff = { ...env, ...derived }; const forcedOverrides = Object.entries(FORCED_ENV).filter(([k, v]) => env[k] !== undefined && env[k] !== v).map(([k, v]) => ({ name: k, now: v, was: k === 'JUDGE_MODE' ? env[k] : '<value>' }));
  const root = profile.root; const config = loadConfig(); const dataDir = dataDirOf(config);
  // ---- A. CODE --------------------------------------------------------------------------------------------------------------------
  const commit = git(root, ['rev-parse', 'HEAD']); const porcelain = git(root, ['status', '--porcelain', '--untracked-files=no']); const identity = codeIdentity({ root });
  let mrPolicy = null; let mrDigest = null; let judgePolicy = null; let judgeDigest = null; let subjects = null;
  try { mrPolicy = readPolicyFile(profileFileOf(profile, 'marketResearchPolicy')); mrDigest = policyDigest(mrPolicy); } catch (err) { block('CORE_CODE_BLOCKER', 'MARKET_RESEARCH_POLICY', `paper market-research policy does not load: ${err.message}`); }
  try { subjects = readSubjectsFile(profileFileOf(profile, 'marketResearchSubjects')); } catch (err) { block('CORE_CODE_BLOCKER', 'MARKET_RESEARCH_SUBJECTS', `paper subjects do not load: ${err.message}`); }
  try { const l = loadJudgePolicy(profileFileOf(profile, 'judgePolicy')); judgePolicy = l.policy; judgeDigest = l.digest; } catch (err) { block('CORE_CODE_BLOCKER', 'JUDGE_POLICY', `paper Judge policy does not load: ${err.message}`); }
  sections.A_CODE = { commit, worktreeClean: porcelain === null ? null : porcelain.length === 0, dirtyFiles: porcelain ? porcelain.split('\n').filter(Boolean).length : null, researchSourceTreeSha256: identity.sourceTreeSha256, identityLaw: identity.law, profile: { file: profile.file, version: profile.profileVersion, name: profile.profileName, runtimeMode: profile.runtimeMode }, policyDigests: { marketResearch: mrDigest, judge: judgeDigest }, configOverlay: profile.configOverlay ?? null, forcedEnvironment: FORCED_ENV, forcedOverrides, nodeVersion: process.version };
  if (porcelain && porcelain.length) warnings.push({ id: 'WORKTREE_DIRTY', detail: `${porcelain.split('\n').filter(Boolean).length} tracked file(s) modified: code identity records PRODUCED_BY_UNCOMMITTED_SOURCE` });
  // ---- B. STORAGE ----------------------------------------------------------------------------------------------------------------
  let writable = false; try { mkdirSync(dataDir, { recursive: true }); const probe = path.join(dataDir, '.preflight-probe'); writeFileSync(probe, 'ok'); rmSync(probe); writable = true; } catch (err) { block('CORE_RUNTIME_BLOCKER', 'DATA_DIR', `data dir ${dataDir} not writable: ${err.message}`, 'set COBRA_DATA_DIR to a writable path'); }
  const dbConfigured = present(env, 'DATABASE_URL'); const durable = durabilityRequired(env); let db = { configured: dbConfigured, reachable: null, schemaVersion: null, buildSchemaVersion: SCHEMA_VERSION, schemaCurrent: null, accountInitialized: null, writerLockHeld: null, error: null };
  const acct = profile.groups.judge.judge.accountId ?? judgePolicy?.account?.accountId ?? null;
  if (!dbConfigured) block('CORE_RUNTIME_BLOCKER', 'DATABASE_URL', 'DATABASE_URL is not configured: PAPER needs the PostgreSQL journal authority (Judge account + RUMOR2 event root)', 'set DATABASE_URL (see .env.paper.example)');
  else {
    let conn = null;
    try {
      const { Db } = await import('../persistence/db.js'); conn = dbFactory ? dbFactory() : new Db({ log: () => {} });
      const ok = await conn.connect(); db.reachable = ok === true || ok === undefined ? true : Boolean(ok);
      if (!db.reachable) block('CORE_RUNTIME_BLOCKER', 'DATABASE', 'database configured but unreachable', 'check DATABASE_URL / network; the runtime would boot with PERSISTENCE_PERMISSION_LOCK');
      else {
        let v = null; try { v = await conn.query('SELECT max(version) AS v FROM serpent_schema_migrations'); } catch (err) { if (err?.code !== '42P01') throw err; v = { rows: [{ v: null }] }; /* no migrations table yet: the persistence bootstrap creates it at launch */ }
        db.schemaVersion = v.rows[0]?.v === null || v.rows[0]?.v === undefined ? 0 : Number(v.rows[0].v); db.schemaCurrent = db.schemaVersion === SCHEMA_VERSION;
        if (db.schemaVersion > SCHEMA_VERSION) block('CORE_RUNTIME_BLOCKER', 'SCHEMA', `database schema ${db.schemaVersion} is newer than this build (${SCHEMA_VERSION})`); else if (db.schemaVersion < SCHEMA_VERSION) warnings.push({ id: 'SCHEMA_BEHIND', detail: `schema ${db.schemaVersion} < build ${SCHEMA_VERSION}: the persistence bootstrap applies migrations at launch` });
        if (acct) {
          try {
            const a = await conn.query('SELECT 1 FROM serpent_execution_accounts WHERE account_id = $1', [acct]);
            if (!Array.isArray(a?.rows) || a.rows.length > 1 || !a.rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && Object.values(r).length === 1 && Object.values(r)[0] === 1)) throw invalidStorageResult();
            db.accountInitialized = a.rows.length === 1;
          } catch (err) {
            db.accountInitialized = err?.code === '42P01' ? false : null;
            if (db.accountInitialized === null) block('CORE_RUNTIME_BLOCKER', 'JUDGE_ACCOUNT_CHECK', storageCheckFailure('Paper account', err), 'restore database access and rerun preflight');
          }
          if (db.accountInitialized === false) block('CORE_RUNTIME_BLOCKER', 'JUDGE_ACCOUNT', `paper account ${acct} is not initialized`, `node bin/judge.js init-paper --policy ${profile.files.judgePolicy} --owner-stdin true (owner intent; once)`);
        }
        if (acct) {
          try {
            const name = `serpent_execution_writer:${conn.schema ?? 'public'}:${acct}`;
            const l = await conn.query('SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = $1 AND classid = ((hashtext($2)::bigint >> 32) & 4294967295) AND objid = (hashtext($2)::bigint & 4294967295)) AS held', ['advisory', name]);
            if (!Array.isArray(l?.rows) || l.rows.length !== 1 || typeof l.rows[0]?.held !== 'boolean') throw invalidStorageResult();
            db.writerLockHeld = l.rows[0].held;
            if (db.writerLockHeld) block('CORE_RUNTIME_BLOCKER', 'WRITER_HELD', `another writer holds the ${acct} journal lock (a Serpent already running this account?)`, 'stop the other process before launching a second paper runtime');
          } catch (err) {
            db.writerLockHeld = null;
            block('CORE_RUNTIME_BLOCKER', 'WRITER_LOCK_CHECK', storageCheckFailure('Writer lock', err), 'restore database access and rerun preflight');
          }
        }
      }
    } catch (err) { db.error = bounded(err.message); block('CORE_RUNTIME_BLOCKER', 'DATABASE', `database check failed: ${bounded(err.message)}`); }
    finally { if (conn && typeof conn.end === 'function') { try { await conn.end(); } catch { /* released */ } } }
  }
  sections.B_STORAGE = { dataDir, writable, durabilityRequired: durable, database: db, localJournalFallback: eff.RUMOR2_ALLOW_LOCAL_JOURNAL === 'true' };
  // ---- the shared snapshot (status files as they are NOW; nothing started) ------------------------------------------------------
  const snap = sensorSnapshot({ profile, env: eff, config, dataDir, now: now() }); const row = (id) => snapshotRow(snap, id);
  // ---- C. CORE MARKET -----------------------------------------------------------------------------------------------------------
  const tape = row('TAPE'); const eye = row('WIDEEYE'); const uni = row('UNIVERSE_EXPANSION');
  sections.C_CORE_MARKET = { tape: { ...tape, willStart: true, wsUrl: config.tape?.wsUrl ?? null }, wideEye: { ...eye, configEnabled: config.wideeye?.enabled === true }, universe: { ...uni, configEnabled: config.universeExpansion?.enabled === true, seeds: config.universe ?? [] }, featureFreshness: tape.lastSuccessTs ? { ageMs: tape.ageMs, staleFeedSec: config.tape?.staleFeedSec ?? null } : { ageMs: null, note: 'no tape status yet (not running); freshness is proven by the running tape' } };
  if (!config.tape?.wsUrl || !/^wss:\/\/ws\.kraken\.com\//.test(config.tape.wsUrl)) block('CORE_CODE_BLOCKER', 'TAPE_CONFIG', 'cobra.config.json tape.wsUrl is not the Kraken public WS v2');
  if (config.wideeye?.enabled !== true) block('CORE_RUNTIME_BLOCKER', 'WIDEEYE', 'wide eye is not enabled by the effective config (profile overlay missing?)');
  // ---- D. RUMOR OFFICIAL --------------------------------------------------------------------------------------------------------
  const official = ['KRAKEN_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL', 'EDGAR_OFFICIAL', 'OFAC_OFFICIAL'].map(row);
  sections.D_RUMOR_OFFICIAL = { rumor2Enabled: eff.RUMOR2_ENABLED === 'true', contactConfigured: present(env, 'SERPENT_HTTP_CONTACT'), providers: official, legacyRumint: row('RUMINT_STOCKTWITS_AGGREGATE') };
  for (const p of official) if (p.state.startsWith('CONFIG_REQUIRED')) block('EXTERNAL_OPTIONAL_SENSE_BLOCKER', p.id, `${p.state}: ${p.blocker}`, p.id === 'EDGAR_OFFICIAL' ? 'set RUMOR2_EDGAR_CIKS (your own CIK whitelist) and SERPENT_HTTP_CONTACT' : 'set SERPENT_HTTP_CONTACT (SEC user-agent law)');
  // ---- E. SOCIAL -------------------------------------------------------------------------------------------------------------------
  // the social readiness projection is the collector's OWN (published in its status record); the preflight reads it, never recomputes it
  const matrix = readJsonBounded(path.join(dataDir, 'rumor2', 'status.json'))?.socialReadiness ?? null; const xState = xGovernorState(env);
  const socialRows = ['BLUESKY_OFFICIAL', 'X_OFFICIAL', 'FARCASTER_OFFICIAL', 'REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL', 'META_PUBLIC', 'TIKTOK_PUBLIC', 'YOUTUBE_OFFICIAL', 'YOUTUBE_DATA_API'].map((id) => { const r = row(id); const m = (Array.isArray(matrix?.providers) ? matrix.providers : []).find((p) => p.provider === id) ?? null; return { ...r, matrixReadiness: m?.readiness ?? null, matrixBlockers: m?.blockers ?? [], ...(id === 'X_OFFICIAL' ? { governor: xState, governorDetail: xState === 'READY_REQUIRES_EXPLICIT_PAID_SMOKE' ? 'credential + budgets present; an EXPLICIT paid smoke envelope is still the law before the stream connects' : xState } : {}) }; });
  sections.E_SOCIAL = { blueskyRequested: eff.RUMOR2_SOCIAL_BLUESKY_ENABLED === 'true', providers: socialRows, matrixVersion: matrix?.version ?? null, matrixSource: matrix ? 'collector status (published projection)' : 'NOT_OBSERVED (the collector has not published its readiness projection yet)' };
  block('PAID_SENSE_NOT_AUTHORIZED', 'X_OFFICIAL', `X NOT OPERATIONAL: ${xState}`, xState === 'CREDENTIAL_MISSING' ? 'set X_BEARER_TOKEN + the three RUMOR2_SOCIAL_X_MAX_* budgets, then an explicit paid smoke envelope' : xState === 'BUDGET_NOT_CONFIGURED' ? 'set RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS / _MONTHLY_POST_READS / _ESTIMATED_DAILY_USD' : 'run the explicit paid smoke (RUMOR2_SOCIAL_X_LIVE_SMOKE_*)');
  for (const r of socialRows) if (['FOUNDATION_ONLY', 'BLOCKED_RETENTION', 'BLOCKED_TERMS', 'BLOCKED_EXTERNAL_APPROVAL'].includes(r.state)) block('EXTERNAL_OPTIONAL_SENSE_BLOCKER', r.id, `${r.state}: ${r.blocker}`);
  // The optional source families are intentionally reported from their
  // durable sensor rows as well; a social-only line must not imply that
  // YouTube, infrastructure, or publisher news was observed.
  const sensor = (id) => snap.rows.find((x) => x.id === id) ?? null;
  sections.E_SOCIAL.youtube = sensor('YOUTUBE_DATA_API');
  sections.E_SOCIAL.youtubeOfficial = sensor('YOUTUBE_OFFICIAL');
  sections.E_SOCIAL.meta = sensor('META_PUBLIC');
  sections.D_RUMOR_OFFICIAL.tally = sensor('GOVERNANCE_TALLY');
  sections.D_RUMOR_OFFICIAL.infrastructure = snap.rows.filter((x) => x.group === 'INFRASTRUCTURE');
  sections.D_RUMOR_OFFICIAL.press = snap.rows.filter((x) => x.group === 'PUBLISHER_NEWS');
  // ---- F. MARKET RESEARCH -----------------------------------------------------------------------------------------------------
  let probe = null; const presence = mrPolicy ? credentialPresence(mrPolicy, env) : null;
  if (smoke && mrPolicy && subjects) { const tmp = mkdtempSync(path.join(tmpdir(), 'serpent-preflight-')); try { const r = await runCoverage({ policy: mrPolicy, subjects, env, out: path.join(tmp, 'coverage'), probe: true, fetchImpl, clock: now, researchRoot: marketResearchRootFromEnv(eff, dataDir) }); const results = {}; try { const walk = (v) => { if (Array.isArray(v)) { for (const x of v) walk(x); return; } if (v && typeof v === 'object') { if (typeof v.providerId === 'string' && v.probe && typeof v.probe === 'object' && !(v.providerId in results)) results[v.providerId] = probeFacts(v.probe); for (const x of Object.values(v)) walk(x); } }; walk(JSON.parse(readFileSync(path.join(tmp, 'coverage', r.file ?? 'coverage-matrix.json'), 'utf8'))); } catch { /* matrix unreadable: probe facts stay null */ }
      probe = { results, accounting: r.accounting ?? null, families: r.families ?? null }; } catch (err) { probe = { error: bounded(err.message) }; } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ } } }
  const probeOf = (id) => probe?.results?.[id] ?? null;
  const mrRows = Object.keys(profile.groups.marketResearch.providers).map((id) => { const r = row(id); const pol = mrPolicy?.providers?.[id] ?? null; return { ...r, policyEnabled: pol?.enabled ?? null, billing: pol?.plan?.billing ?? null, credentialEnv: pol?.credentialEnv ?? null, credentialPresent: pol?.credentialEnv ? present(env, pol.credentialEnv) : null, access: presence?.[id]?.access ?? null, smokeProbe: probeOf(id) }; });
  sections.F_MARKET_RESEARCH = { serviceRequested: eff.MARKET_RESEARCH_ENABLED === 'true', policyFile: profile.files.marketResearchPolicy, policyDigest: mrDigest, researchRoot: marketResearchRootFromEnv(eff, dataDir), providers: mrRows, smokePerformed: smoke && probe !== null, smokeError: probe?.error ?? null };
  for (const r of mrRows) { if (r.state === 'BLOCKED_BUDGET') block('PAID_SENSE_NOT_AUTHORIZED', r.id, `${r.id}: ${r.blocker}`, 'attest plan + billing in the policy (plan.attestation, smoke.maxEstimatedUsd) before any paid call'); else if (r.state === 'BLOCKED_CREDENTIAL') block('EXTERNAL_OPTIONAL_SENSE_BLOCKER', r.id, `${r.id}: ${r.blocker}`); else if (r.desiredState === 'OFF' && r.id === 'BYBIT') block('EXTERNAL_OPTIONAL_SENSE_BLOCKER', r.id, 'BYBIT: BLOCKED_GEOGRAPHY (HTTP 403 from this environment); no unofficial mirror'); }
  // ---- G. DARK EDGE CAPTURE ---------------------------------------------------------------------------------------------------------
  const charts = row('KRAKEN_CHARTS_DARK'); const l3 = row('KRAKEN_L3_DARK'); let l3Probe = null; let chartsProbe = null;
  if (smoke && mrPolicy) {
    const lp = l3Policy(mrPolicy);
    if (present(env, [lp.keyEnv, lp.secretEnv])) { try { const { createHttpTransport } = await import('../market-lab/transport.js'); const { createL3AuthHelper } = await import('../market-lab/providers/kraken-l3-auth.js'); const t = createHttpTransport({ fetchImpl, clock: now, log: () => {} }); const auth = createL3AuthHelper({ transport: t, clock: now, env, keyEnv: lp.keyEnv, secretEnv: lp.secretEnv, log: () => {} }); const p = await auth.proveDataKey(); l3Probe = { verdict: p.verdict, blocker: p.blocker ?? null, l3Usable: p.ok === true, keyFingerprint: p.keyFingerprint ?? null, tokenPermission: p.tokenPermission ?? null, forbidden: p.forbidden ?? [] }; if (typeof t.stop === 'function') await t.stop(); } catch (err) { l3Probe = { verdict: 'PROBE_FAILED', blocker: bounded(err.message), l3Usable: false }; } }
    else l3Probe = { verdict: 'CREDENTIAL_MISSING', blocker: 'CREDENTIAL_MISSING', l3Usable: false };
    if (chartsPolicy(mrPolicy).enabled && mrPolicy.providers.KRAKEN_DERIVATIVES?.enabled) { try { const { createHttpTransport } = await import('../market-lab/transport.js'); const { createKrakenDerivativesClient } = await import('../market-lab/providers/kraken-derivatives.js'); const { createKrakenChartsClient } = await import('../market-lab/providers/kraken-charts.js'); const t = createHttpTransport({ fetchImpl, clock: now, log: () => {} }); const d = createKrakenDerivativesClient({ transport: t, clock: now, log: () => {} }); const cat = await d.loadInstruments(); const c = createKrakenChartsClient({ transport: t, clock: now, log: () => {}, resolveInstrument: d.resolveInstrument, charts: chartsPolicy(mrPolicy) }); const sym = (subjects?.subjects ?? []).map((s) => s.krakenDerivatives).find((s) => typeof s === 'string' && d.resolveInstrument(s).ok) ?? null; const r = sym ? await c.pollForward({ symbol: sym, analyticsType: chartsPolicy(mrPolicy).analyticsTypes[0], intervalS: chartsPolicy(mrPolicy).intervalsS[0] }) : null; chartsProbe = { catalogOk: cat.ok === true, symbol: sym, ok: r?.ok ?? false, observations: r?.observations?.length ?? 0, acquisition: r?.meta?.acquisition ?? null, failure: r?.failure?.kind ?? null, coverage: r?.coverage?.[0]?.state ?? null }; if (typeof t.stop === 'function') await t.stop(); } catch (err) { chartsProbe = { ok: false, failure: bounded(err.message) }; } }
  }
  const l3State = l3Probe ? (l3Probe.l3Usable ? 'SAFE_L3_DATA_KEY' : 'BLOCKED_NO_SAFE_L3_DATA_KEY') : l3.state;
  sections.G_DARK_EDGE_CAPTURE = { krakenCharts: { ...charts, smokeProbe: chartsProbe }, krakenL3: { ...l3, verdictState: l3State, smokeProbe: l3Probe }, law: 'EDGE_CAPTURE only; zero Judge / Socrates / Watch / execution authority; edge claim NOT_MADE; never a PAPER readiness blocker' };
  if (l3State !== 'SAFE_L3_DATA_KEY' && !l3State.startsWith('DARK_CAPTURE_OPERATIONAL')) block('DARK_RESEARCH_BLOCKER', 'KRAKEN_L3', `Kraken L3: ${l3Probe ? `${l3Probe.verdict}${l3Probe.blocker ? ` (${l3Probe.blocker})` : ''}` : l3.state}`, l3State === 'KEY_PRESENT_UNPROVEN' ? 'run preflight --smoke for the read-only permission probe' : 'a DEDICATED data-only Kraken key with create-ws-token and no trade / withdraw / funding permission (never an execution key)');
  if (charts.state === 'DARK_CAPTURE_DISABLED_BY_POLICY') block('DARK_RESEARCH_BLOCKER', 'KRAKEN_CHARTS', 'charts capture disabled by the paper policy'); else if (chartsProbe && !chartsProbe.ok) block('DARK_RESEARCH_BLOCKER', 'KRAKEN_CHARTS', `charts smoke failed: ${chartsProbe.failure ?? 'no observation'}`);
  // ---- H. SOCRATES -----------------------------------------------------------------------------------------------------------------
  const socRt = row('SOCRATES_CASE_RUNTIME'); const socModel = row('SOCRATES_MODEL');
  sections.H_SOCRATES = { caseRuntime: socRt, model: { ...socModel, credentialEnv: mrPolicy?.model?.credentialEnv ?? null, credentialPresent: mrPolicy ? present(env, mrPolicy.model.credentialEnv) : null, enabledInPolicy: mrPolicy?.model?.enabled ?? null, usdCaps: mrPolicy ? { perCase: mrPolicy.model.maxEstimatedUsdPerCase, perDay: mrPolicy.model.maxEstimatedUsdPerDay, perMonth: mrPolicy.model.maxEstimatedUsdPerMonth } : null }, law: 'model output is interpretation, never source truth; a case without an authorized model seals BUDGET_BLOCKED; the Judge runs MARKET_DIRECT setups without a case and never invents one' };
  if (socModel.state !== 'ACTIVE') block('PAID_SENSE_NOT_AUTHORIZED', 'SOCRATES_MODEL', `Socrates model: ${socModel.blocker}`, 'set ANTHROPIC_API_KEY AND explicit model.* USD caps + model.enabled in config/market-research.paper.json (never inferred from the key)');
  // ---- I. JUDGE (PAPER readiness only) -------------------------------------------------------------------------------------------
  const judge = row('JUDGE'); const jp = judgePolicy;
  const judgeChecks = { policyLoads: jp !== null, policyMode: jp?.mode ?? null, adapter: jp?.execution?.adapter ?? null, liveBlockPresent: jp ? jp.live !== null && jp.live !== undefined : null, envMode: eff.JUDGE_MODE, envAllowPrivate: eff.JUDGE_ALLOW_PRIVATE, envAllowOrders: eff.JUDGE_ALLOW_ORDERS, accountId: acct, accountInitialized: db.accountInitialized, writerLockHeld: db.writerLockHeld, liveArmedPossible: false };
  sections.I_JUDGE = { ...judge, checks: judgeChecks, realMoney: 'DISABLED', liveOrders: 'DISABLED', withdrawFunding: 'DISABLED' };
  if (jp && jp.mode !== 'PAPER') block('CORE_CODE_BLOCKER', 'JUDGE_POLICY_MODE', `paper Judge policy mode is ${jp.mode}, not PAPER`); if (jp && jp.execution?.adapter !== 'PAPER') block('CORE_CODE_BLOCKER', 'JUDGE_ADAPTER', `paper Judge policy adapter is ${jp.execution?.adapter}, not PAPER`); if (jp && jp.live) block('CORE_CODE_BLOCKER', 'JUDGE_LIVE_BLOCK', 'the paper Judge policy carries a live block');
  if (eff.JUDGE_MODE !== 'PAPER' || eff.JUDGE_ALLOW_PRIVATE !== 'false' || eff.JUDGE_ALLOW_ORDERS !== 'false') block('CORE_CODE_BLOCKER', 'JUDGE_ENV', 'the effective Judge environment is not PAPER / allowPrivate false / allowOrders false');
  // ---- J. WATCH ---------------------------------------------------------------------------------------------------------------------
  const watch = row('WATCH'); const checkpoint = acct ? path.join(dataDir, 'execution', `paper-checkpoint-${acct}.json`) : null;
  sections.J_WATCH = { ...watch, composedBy: 'judge/composition.js', recovery: { paperCheckpointPresent: checkpoint ? existsSync(checkpoint) : null, journalReplay: 'PostgreSQL journal (replayVerify at startup; exposed positions re-owned by the Watch)' }, law: 'loss of fresh data makes the Watch more restrictive; KILL outranks Watch preference; a paper exit is an intent + simulated reconciliation, never a real order' };
  // ---- K. CONTROLS ------------------------------------------------------------------------------------------------------------------
  let controls = null; let locks = null; try { const c = readControls(); controls = { kill: Boolean(c?.kill?.active), cage: Boolean(c?.cage?.active), vetoes: Array.isArray(c?.vetoes) ? c.vetoes.length : null }; } catch (err) { controls = { error: bounded(err.message) }; }
  try { const l = dailyLockStatus(); locks = { level: l.level, strikesAllowed: l.strikes_allowed, pnlPct: Number(l.pnl_pct.toFixed(4)), sessionDate: l.session_date, simulated: l.simulated }; } catch (err) { locks = { error: bounded(err.message) }; }
  sections.K_CONTROLS = { controls, dailyLock: locks, controlAuthConfigured: present(env, 'SERPENT_CONTROL_PASSWORD'), note: controls?.kill ? 'KILL latched: the paper runtime boots RETREAT (no entries) until a human CLEAR' : controls?.cage ? 'CAGE latched: no new entries' : 'no latch' };
  if (!present(env, 'SERPENT_CONTROL_PASSWORD')) warnings.push({ id: 'CONTROL_AUTH_UNCONFIGURED', detail: 'SERPENT_CONTROL_PASSWORD unset: cockpit KILL / CAGE / CLEAR controls stay unauthenticated-refused (observe-only)' });
  return finish({ startedTs, now, profile, sections, blockers, warnings, smoke, env, snapshot: snap, secrets: secretPresence(profile, env) });
}
function finish({ startedTs, now, profile, sections, blockers, warnings, smoke, env, snapshot = null, secrets = null }) {
  const core = blockers.CORE_CODE_BLOCKER.length + blockers.CORE_RUNTIME_BLOCKER.length; const ready = core === 0;
  const authority = { realMoney: 'DISABLED', liveOrders: 'DISABLED', withdrawFunding: 'DISABLED', paperMode: ready ? 'READY_FOR_PAPER' : 'NOT_READY_FOR_PAPER', darkKrakenJudgeAuthority: 'NONE', darkKrakenSocratesAuthority: 'NONE', thresholdChanges: 'NONE' };
  sections.L_FINAL = { READY_FOR_PAPER: ready, verdict: ready ? 'READY_FOR_PAPER' : 'NOT_READY_FOR_PAPER', coreBlockers: [...blockers.CORE_CODE_BLOCKER, ...blockers.CORE_RUNTIME_BLOCKER], optionalBlockers: blockers.EXTERNAL_OPTIONAL_SENSE_BLOCKER.length, paidNotAuthorized: blockers.PAID_SENSE_NOT_AUTHORIZED.length, darkResearchBlockers: blockers.DARK_RESEARCH_BLOCKER.length, authority };
  const report = { preflightVersion: PREFLIGHT_VERSION, generatedTs: startedTs, durationMs: now() - startedTs, profile: profile ? { file: profile.file, name: profile.profileName, runtimeMode: profile.runtimeMode } : null, smoke, readOnly: true, paidCalls: 0, sections, blockers, warnings, secretNamesPresent: secrets ? Object.entries(secrets).filter(([, v]) => v).map(([k]) => k) : [], snapshot, ready, verdict: sections.L_FINAL.verdict, authority };
  const text = JSON.stringify(report); if (NO_SECRET.test(text)) throw new Error('preflight: a value-like secret reached the report'); void env;
  return report;
}
// the operator-facing text rendering (JSON is the machine form)
export function renderPreflight(r) {
  const L = []; const line = (s) => L.push(s); const mark = (ok) => (ok ? 'OK ' : 'NO ');
  line(`SERPENT PAPER PREFLIGHT ${r.preflightVersion} — ${new Date(r.generatedTs).toISOString()} — ${r.smoke ? 'read-only smokes ON (zero paid calls)' : 'no network (read-only)'}`);
  if (!r.profile) { line(`profile: INVALID`); for (const b of r.blockers.CORE_CODE_BLOCKER) line(`  ! ${b.id}: ${b.reason}`); line(`L. FINAL: ${r.verdict}`); return L.join('\n'); }
  const s = r.sections; const A = s.A_CODE; const B = s.B_STORAGE;
  line(`profile: ${r.profile.file} (${r.profile.name}, ${r.profile.runtimeMode})`);
  line(`A. CODE      commit ${A.commit ? A.commit.slice(0, 12) : 'no git'} · worktree ${A.worktreeClean === null ? 'unknown' : A.worktreeClean ? 'clean' : `DIRTY (${A.dirtyFiles})`} · research tree ${(A.researchSourceTreeSha256 ?? 'null').slice(0, 12)} · policy digests mr ${(A.policyDigests.marketResearch ?? 'INVALID').slice(0, 12)} judge ${(A.policyDigests.judge ?? 'INVALID').slice(0, 12)} · profile ${A.profile.version}${A.forcedOverrides.length ? ` · FORCED ${A.forcedOverrides.map((o) => `${o.name}=${o.now}`).join(',')}` : ''}`);
  line(`B. STORAGE   data dir ${mark(B.writable)}${B.dataDir} · PostgreSQL ${B.database.configured ? (B.database.reachable ? `reachable, schema ${B.database.schemaVersion}/${B.database.buildSchemaVersion}` : 'configured, UNREACHABLE') : 'NOT CONFIGURED'} · account ${B.database.accountInitialized === null ? 'unknown' : B.database.accountInitialized ? 'initialized' : 'NOT INITIALIZED'} · writer lock ${B.database.writerLockHeld === null ? 'unknown' : B.database.writerLockHeld ? 'HELD' : 'free'} · local journal fallback ${B.localJournalFallback ? 'ON (!)' : 'off'}`);
  const C = s.C_CORE_MARKET; line(`C. CORE      tape ${C.tape.state} (${C.tape.blocker ?? 'fresh'}) · wide eye ${C.wideEye.state} · universe ${C.universe.state} (${C.universe.coverage}) · feature freshness ${C.featureFreshness.ageMs === null ? 'n/a (not running)' : `${C.featureFreshness.ageMs} ms`}`);
  line(`D. OFFICIAL  rumor2 ${s.D_RUMOR_OFFICIAL.rumor2Enabled ? 'requested' : 'off'} · ${s.D_RUMOR_OFFICIAL.providers.map((p) => `${p.id} ${p.state}`).join(' · ')} · legacy ${s.D_RUMOR_OFFICIAL.legacyRumint.state} · Tally ${s.D_RUMOR_OFFICIAL.tally?.state ?? 'NOT_OBSERVED'}`);
  line(`E. SOCIAL    ${s.E_SOCIAL.providers.map((p) => `${p.id} ${p.state ?? 'NOT_OBSERVED'}${p.governor ? ` [${p.governor}]` : ''}`).join(' · ')}`);
  const infraRows = s.D_RUMOR_OFFICIAL.infrastructure ?? []; const pressRows = s.D_RUMOR_OFFICIAL.press ?? [];
  line(`E2. YOUTUBE  official ${s.E_SOCIAL.youtubeOfficial?.state ?? 'NOT_OBSERVED'} · video ${s.E_SOCIAL.youtube?.state ?? 'NOT_OBSERVED'}${s.E_SOCIAL.youtube?.coverage ? ` (${s.E_SOCIAL.youtube.coverage})` : ''}`);
  line(`E3. INFRA    ${infraRows.length ? infraRows.map((p) => `${p.id} ${p.state ?? 'NOT_OBSERVED'}`).join(' · ') : 'NOT_OBSERVED'}`);
  line(`E4. PRESS    ${pressRows.length ? pressRows.map((p) => `${p.id} ${p.state ?? 'NOT_OBSERVED'}`).join(' · ') : 'NOT_OBSERVED'}`);
  const smokeText = (sp) => { if (!sp) return ''; const st = sp.state ?? sp.ok ?? '?'; const why = sp.reason ? ` ${sp.reason}` : ''; const n = sp.count === null || sp.count === undefined ? '' : ` ${sp.count} record${sp.count === 1 ? '' : 's'}${sp.count === 0 ? ' (successful empty response)' : ''}`; return ` [smoke ${st}${why}${n}]`; };
  line(`F. RESEARCH  service ${s.F_MARKET_RESEARCH.serviceRequested ? 'requested' : 'off'} · ${s.F_MARKET_RESEARCH.providers.map((p) => `${p.id} ${p.state}${smokeText(p.smokeProbe)}`).join(' · ')}`);
  const G = s.G_DARK_EDGE_CAPTURE; line(`G. DARK      charts ${G.krakenCharts.state}${G.krakenCharts.smokeProbe ? ` [smoke ${G.krakenCharts.smokeProbe.ok ? 'ok ' + G.krakenCharts.smokeProbe.observations + ' obs ' + G.krakenCharts.smokeProbe.acquisition : 'FAILED ' + G.krakenCharts.smokeProbe.failure}]` : ''} · L3 ${G.krakenL3.verdictState}${G.krakenL3.smokeProbe ? ` [probe ${G.krakenL3.smokeProbe.verdict}${G.krakenL3.smokeProbe.blocker ? ' ' + G.krakenL3.smokeProbe.blocker : ''}]` : ''} · authority NONE`);
  line(`H. SOCRATES  runtime ${s.H_SOCRATES.caseRuntime.state} · model ${s.H_SOCRATES.model.state} (${s.H_SOCRATES.model.blocker ?? 'authorized'})`);
  const I = s.I_JUDGE; line(`I. JUDGE     ${I.state} · policy mode ${I.checks.policyMode} adapter ${I.checks.adapter} · env ${I.checks.envMode} private ${I.checks.envAllowPrivate} orders ${I.checks.envAllowOrders} · account ${I.checks.accountId} ${I.checks.accountInitialized === null ? '' : I.checks.accountInitialized ? 'initialized' : 'NOT INITIALIZED'} · LIVE armed possible: no`);
  line(`J. WATCH     ${s.J_WATCH.state} · checkpoint ${s.J_WATCH.recovery.paperCheckpointPresent === null ? 'n/a' : s.J_WATCH.recovery.paperCheckpointPresent ? 'present' : 'none'} · ${s.J_WATCH.detail}`);
  const K = s.K_CONTROLS; line(`K. CONTROLS  kill ${K.controls?.kill ? 'ACTIVE' : 'off'} · cage ${K.controls?.cage ? 'ACTIVE' : 'off'} · daily lock ${K.dailyLock?.level ?? '?'} (${K.dailyLock?.sessionDate ?? '?'}) · control auth ${K.controlAuthConfigured ? 'configured' : 'UNCONFIGURED'}`);
  line(`L. FINAL     ${r.verdict}`);
  for (const g of BLOCKER_GROUPS) { const bs = r.blockers[g]; if (!bs.length) continue; line(`   ${g} (${bs.length})`); for (const b of bs) line(`     - ${b.id}: ${b.reason}${b.remedy ? ` -> ${b.remedy}` : ''}`); }
  for (const w of r.warnings) line(`   warning ${w.id}: ${w.detail}`);
  for (const l of authorityLines(r.authority.paperMode)) line(`   ${l}`);
  return L.join('\n');
}
