// JUDGE — the ONE controlled composition (ticket §9.1): one top-level assembly per mode, used by bin/judge.js and by
// fly.js's explicit opt-in. It injects read-only market / case accessors into Judge and OWNS execution / Watch. The research
// service remains a producer (never imports the execution writer). Default startup remains non-trading: without
// JUDGE_ENABLED=true and an explicit policy / account / mode nothing here is constructed. LIVE credentials are read ONLY
// from the environment names the policy declares, only for LIVE modes, and are never logged, exported or serialized.
// Entry permission is the intersection of authenticated controls, account mode / release / authorization, risk and
// health (each enforced by the reducer / Judge / Watch); no posture label grants permission or invents a fill.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { sessionDate } from '../lib/time.js';
import { Db } from '../persistence/db.js';
import { runMigrations } from '../persistence/migrate.js';
import { createPgJournal, createMemoryJournal, JournalError } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createKrakenAdapter, createNonceStore, specFromAssetPair, KRAKEN_REST_BASE } from '../execution/kraken-adapter.js';
import { createPermissionClock } from '../execution/clock.js';
import { feeContract, instrumentSpec, makeEvent, keyFingerprint } from '../execution/contract.js';
import { createJudge } from './judge.js';
import { createWatch } from '../watch/watch.js';
import { readControls } from '../state/controls.js';
import { dailyLockStatus } from '../state/locks.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { loadJudgePolicy } from './policy.js';
import { evaluateAccount } from './challengers.js';
import { sealsReport, buildLiveAuthorization } from './arming.js';
import { createBarHistory } from './history.js';
import { createCaseSource } from './case-source.js';
import { createFeedRecorder } from './recorder.js';
import { selectPreparation } from './readiness.js';
import { codeTreeDigest } from './owner.js';

export const COMPOSITION_VERSION = 'judge-composition-1';
export const RUN_MODES = Object.freeze(['OBSERVE', 'REPLAY', 'PAPER', 'LIVE_UNARMED', 'LIVE_ARMED']);
export const judgeDir = () => path.join(dataDir(), 'execution');
export const projectionFile = () => path.join(judgeDir(), 'projection.json');
export const PROJECTION_VERSION = 'judge-projection-1';
export const PREFLIGHT_MAX_AGE_MS = 15 * 60_000;
export function feeFromPolicy(policy, nowTs) { const f = policy.fees.taker; return feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: f.rate, rateKind: f.rateKind, currency: f.currency, roundingQuantum: f.roundingQuantum, roundingMode: f.roundingMode, minimumFee: f.minimumFee, scope: f.scope, maxExecutionsBound: f.maxExecutionsBound ?? null, boundSource: f.boundSource ?? null, scheduleId: f.scheduleId, observedTs: nowTs }); }
// the account/mode namespace law: one account id belongs to exactly one kind; PAPER never becomes LIVE
export const accountKindOf = (mode) => (mode === 'REPLAY' ? 'REPLAY' : mode === 'PAPER' || mode === 'OBSERVE' ? 'PAPER' : 'LIVE');
export function readCredentials(policy, env, mode) { if (!mode.startsWith('LIVE') || !policy.live) return null; const key = env[policy.live.keyEnv]; const secret = env[policy.live.secretEnv]; if (typeof key !== 'string' || !key.length || typeof secret !== 'string' || !secret.length) return null; return { key, secret }; }
// public instrument specifications from the REST AssetPairs catalog (no key; the ONLY spec source besides an injected fixture)
export async function loadSpecs({ transport, symbols, nowTs }) { const out = []; if (!transport) return out; const r = await transport(`${KRAKEN_REST_BASE}/0/public/AssetPairs`, { method: 'GET' }); if (!r.ok) throw new Error(`AssetPairs ${r.status}`); const body = JSON.parse(await r.text()); if (Array.isArray(body.error) && body.error.length) throw new Error(`AssetPairs ${body.error[0]}`); for (const [pairKey, p] of Object.entries(body.result ?? {})) { if (!symbols.includes(p.wsname)) continue; try { out.push(specFromAssetPair(pairKey, p, { observedTs: nowTs, canonicalCoin: String(p.wsname).split('/')[0] })); } catch { /* an unparseable pair is simply not admitted */ } } return out; }
const excluded = (policy, symbol) => policy.universe.excludeBases.includes(symbol.split('/')[0]);

export async function composeJudge({ policyFile, mode, accountId = null, env = process.env, log = console.log, db = null, journal = null, clock = null, feed = null, transport = null, WebSocketImpl = null, specs = null, history = null, caseSource = null, casesDir = null, controlsSource = null, nominations = null, recordDir = null, allowPrivate = () => false, allowOrders = () => false, requireDb = null, writeProjection = true, codeDigest = undefined }) {
  if (!RUN_MODES.includes(mode)) throw new Error(`mode ${mode} outside ${RUN_MODES.join('/')}`);
  const loaded = loadJudgePolicy(policyFile); const policy = loaded.policy; const policyDigest = loaded.digest; const acct = accountId ?? policy.account.accountId; const kind = accountKindOf(mode);
  if (mode.startsWith('LIVE') && policy.mode !== 'LIVE') throw new Error('a LIVE run needs a LIVE policy (the paper sample cannot be promoted by a flag)'); if (!mode.startsWith('LIVE') && policy.mode === 'LIVE') throw new Error('a LIVE policy cannot run a paper / observe mode account');
  const pclock = clock ?? createPermissionClock({ log }); const nowTs = () => pclock.now(); const treeDigest = codeDigest === undefined ? codeTreeDigest() : codeDigest;
  // ---- journal: PostgreSQL is the authority for PAPER / LIVE; REPLAY and OBSERVE use a memory journal (hypothetical accounts) ----
  let ownDb = null; let jr = journal; const needDb = requireDb ?? (mode === 'PAPER' || mode.startsWith('LIVE'));
  if (!jr) { if (needDb) { ownDb = db ?? new Db({ log }); if (!ownDb.configured()) throw new JournalError('DB_REQUIRED', `${mode} needs DATABASE_URL: the journal authority is PostgreSQL`); if (!(await ownDb.connect())) throw new JournalError('DB_UNAVAILABLE', 'database unreachable: no account authority, no dispatch'); await runMigrations(ownDb, { log }); jr = createPgJournal({ db: ownDb, log }); } else jr = createMemoryJournal({ log }); }
  const exists = await jr.exists(acct); if (!exists && mode !== 'OBSERVE' && mode !== 'REPLAY') throw new JournalError('ACCOUNT_UNINITIALIZED', `account ${acct} is not initialized: run init-${kind.toLowerCase()} with owner intent first`);
  if (!exists) await jr.create(acct, { accountKind: kind });
  const writer = await jr.acquireWriter(acct); if (!writer) throw new JournalError('WRITER_HELD', `another writer owns ${acct}`);
  const loadedAcct = await jr.load(acct); if (loadedAcct.state.initialized && loadedAcct.state.accountKind !== kind) { await writer.release(); throw new JournalError('ACCOUNT_KIND_MISMATCH', `${acct} is a ${loadedAcct.state.accountKind} account; ${mode} needs ${kind}`); }
  // ---- feed / specs / fees / recorder ----
  const fd = feed ?? createExecutionFeed({ clock: nowTs, limits: { maxCandidates: policy.universe.maxCandidates, maxResearch: policy.universe.maxResearch, maxHotSet: policy.universe.maxHotSet }, log });
  const recorder = recordDir ? createFeedRecorder({ dir: recordDir, clock: nowTs, log }) : null;
  const tapeFeed = recorder ? { ...fd, ingest: (raw, ts) => { recorder.record(raw, ts); return fd.ingest(raw, ts); }, onConnect: (ts) => { recorder.record(null, ts, { connect: true }); return fd.onConnect(ts); }, onDisconnect: (ts) => { recorder.record(null, ts, { disconnect: true }); return fd.onDisconnect(ts); } } : fd;
  const fee = feeFromPolicy(policy, nowTs()); const specMap = new Map(); if (specs) for (const s of specs) specMap.set(s.wsname, s); const specOf = (symbol) => specMap.get(symbol) ?? null;
  // ---- adapter ----
  const credentials = readCredentials(policy, env, mode); const fp = credentials ? keyFingerprint(credentials.key) : null;
  const adapter = kind === 'LIVE' ? createKrakenAdapter({ accountId: acct, clock: nowTs, credentials, nonceStore: fp ? createNonceStore({ dir: judgeDir(), fingerprint: fp, wall: nowTs }) : null, transport: transport ?? (mode.startsWith('LIVE') ? (u, i) => fetch(u, i) : null), WebSocketImpl: WebSocketImpl ?? globalThis.WebSocket ?? null, allowPrivate, allowOrders: () => mode === 'LIVE_ARMED' && allowOrders(), log, dataDir: judgeDir() }) : createPaperAdapter({ accountId: acct, clock: nowTs, feed: fd, fee, specOf, latencyMs: policy.execution.paperLatencyMs, maxObservationWaitMs: policy.execution.paperMaxObservationWaitMs, log });
  const dispatcher = createDispatcher({ accountId: acct, journal: jr, writer, adapter, clock: pclock, feed: fd, specOf, log }); await dispatcher.load();
  const controls = controlsSource ?? (() => { const c = readControls(); return { kill: Boolean(c.kill?.active), cage: Boolean(c.cage?.active), vetoes: (c.vetoes ?? []).map((v) => v.prediction_id) }; });
  const lockLevel = () => { try { return dailyLockStatus().level; } catch { return 'NONE'; } };
  const hist = history ?? createBarHistory({ clock: nowTs, fetchImpl: transport, pairKeyOf: (symbol) => specOf(symbol)?.pairKey ?? null, log });
  const cases = caseSource ?? (casesDir ? createCaseSource({ casesDir, clock: nowTs, mode, log }) : { consumed: () => null, refresh: async () => {}, status: () => ({ casesDir: null, known: 0, verified: 0 }) });
  const watch = createWatch({ accountId: acct, dispatcher, adapter, feed: fd, clock: pclock, specOf, feeOf: () => fee, controls, log });
  const judge = createJudge({ accountId: acct, policy, policyDigest, dispatcher, feed: fd, clock: pclock, specOf, feeOf: () => fee, history: hist, caseSource: cases, controls, lockLevel, log, mode });
  if (hist.onTrade) fd.subscribe((e) => { if (e.kind === 'TRADE') hist.onTrade(e.trade); });
  // ---- nominations: the tape's current universe (bounded by the policy), never a research ranking, never a buy list ----
  const nominate = nominations ?? (() => { const u = readCurrentUniverse(); return (u?.pairs ?? []).map((p) => ({ symbol: p.symbol, assetId: p.coin })); });
  // bounded preparation (ticket §4.5 / J11): at most policy.universe.preparationSlots warm candidates, newest nomination first, held assets
  // outside the contest; a candidate that loses its slot is released (never a held / pending one: judge.release refuses those)
  let prepared = new Map(); let lastPreparation = null;
  function admitNominations() { const t = nowTs(); const held = new Set(Object.values(dispatcher.state()?.positions ?? {}).filter((p) => p.state !== 'FLAT').map((p) => p.assetId)); const list = nominate().filter((x) => x?.symbol && !excluded(policy, x.symbol) && specOf(x.symbol)).map((x) => ({ symbol: x.symbol, assetId: x.assetId ?? x.symbol.split('/')[0], source: x.source ?? 'UNIVERSE', nominationKnownAtTs: x.nominationKnownAtTs ?? prepared.get(x.assetId ?? x.symbol.split('/')[0])?.nominationKnownAtTs ?? t }));
    const sel = selectPreparation({ nominations: list, held, remainingSlots: Math.min(policy.universe.preparationSlots, policy.universe.maxCandidates), previous: prepared, nowTs: t }); lastPreparation = { slots: sel.slots, selected: sel.selected.map((n) => n.assetId), preempted: sel.preempted, lost: sel.lost, held: sel.held, ts: t };
    for (const l of sel.lost) { const c = judge.candidates().find((x) => x.assetId === l.assetId); if (c) judge.release(c.symbol); }
    prepared = new Map(sel.selected.map((n) => [n.assetId, n]));
    for (const n of sel.selected) { if (judge.candidates().some((c) => c.symbol === n.symbol)) continue; judge.admit(n.symbol, { assetId: n.assetId, priority: 'CANDIDATE', source: n.source, nominationKnownAtTs: n.nominationKnownAtTs }); }
    return lastPreparation; }
  // ---- authorization continuity (A03 / A04): a changed code / policy / key binding ends the OLD entry authority; exposure stays managed ----
  async function checkAuthorizationBinding() { const s = dispatcher.state(); const a = s?.authorization; if (!a || a.ended || a.expiresTs <= nowTs()) return null; const reasons = []; if (a.policyDigest !== policyDigest) reasons.push('POLICY_CHANGED'); if (a.codeDigest && treeDigest && a.codeDigest !== treeDigest) reasons.push('CODE_CHANGED'); if (a.keyFingerprint && fp && a.keyFingerprint !== fp) reasons.push('KEY_CHANGED'); if (!reasons.length) return null; await dispatcher.commit(makeEvent({ type: 'AUTHORIZATION_ENDED', accountId: acct, knownAtTs: nowTs(), payload: { authorizationId: a.authorizationId, reason: 'BINDING_CHANGED', ts: nowTs() } })); log(`authorization ${a.authorizationId} ended: BINDING_CHANGED (${reasons.join(',')})`); return reasons; }
  let lastPreflight = null;
  async function preflight() { if (kind !== 'LIVE') return { ok: false, reason: 'NOT_A_LIVE_ACCOUNT' }; const r = await adapter.preflight(); lastPreflight = { ...r, ts: nowTs(), accountId: acct, policyDigest }; return lastPreflight; }
  // ARM: the authenticated owner intent has ALREADY been verified by the door (CLI / cockpit); this binds and commits it
  // a preflight report is usable only from THIS key, unexpired (PREFLIGHT_MAX_AGE_MS) and passed; a stale or foreign report is not proof
  const usablePreflight = (p) => (p && p.ok && p.keyFingerprint === fp && Number.isSafeInteger(p.ts) && nowTs() - p.ts <= PREFLIGHT_MAX_AGE_MS ? p : null);
  async function arm({ ownerLimits, expiresTs, allocationCeiling, reinvestment = 'NONE', approval, ownerRef, releaseDigest, canary = null, preflight: given = null }) {
    if (kind !== 'LIVE') return { ok: false, reasons: ['NOT_A_LIVE_ACCOUNT'] };
    const pf = usablePreflight(given ?? lastPreflight); if (policy.live && (expiresTs - nowTs() > policy.live.armExpiryMs)) return { ok: false, reasons: ['OWNER_EXPIRY_EXCEEDS_POLICY'], state: 'BLOCKED' };
    const built = buildLiveAuthorization({ accountId: acct, releaseDigest, policyDigest, codeDigest: treeDigest, allocationCeiling, reinvestment, ownerLimits, keyFingerprint: fp, ownerRef, expiresTs, restrictionRevision: dispatcher.revision(), nowTs: nowTs(), verifiedAvailableUsd: pf ? pf.checks?.balance?.quoteAvailable ?? null : null, preflight: pf, approval, canary });
    if (!built.ok) return built;
    try { await dispatcher.commit(built.event()); } catch (err) { return { ok: false, reasons: [err.detail?.code ?? err.code ?? 'COMMIT_FAILED'], state: 'BLOCKED', detail: String(err.message ?? '').slice(0, 200) }; }
    publishProjection(); return { ok: true, reasons: [], authorizationId: built.payload.authorizationId, expiresTs };
  }
  async function disarm(reason = 'REVOKED') { const a = dispatcher.state()?.authorization; if (!a || a.ended) return { ok: false, reason: 'NO_ACTIVE_AUTHORIZATION' }; await dispatcher.commit(makeEvent({ type: 'AUTHORIZATION_ENDED', accountId: acct, knownAtTs: nowTs(), payload: { authorizationId: a.authorizationId, reason, ts: nowTs() } })); publishProjection(); return { ok: true, authorizationId: a.authorizationId }; }
  let projectionTimer = null;
  function projection() {
    const s = dispatcher.state(); const positions = Object.values(s?.positions ?? {}); const open = positions.filter((p) => p.state !== 'FLAT'); const pending = Object.values(s?.orders ?? {}).filter((o) => !['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.state));
    const a = s?.authorization ?? null; const authorization = a ? { authorizationId: a.authorizationId, kind: a.kind, expiresTs: a.expiresTs, ended: a.ended, active: !a.ended && a.expiresTs > nowTs(), allocationCeiling: a.allocationCeiling, releaseDigest: a.releaseDigest } : null;
    const exiting = open.some((p) => ['EXITING', 'CLOSING', 'DUST'].includes(p.state) || watch.positions().some((w) => w.positionId === p.positionId && w.exit.phase !== 'NONE'));
    return { projectionVersion: PROJECTION_VERSION, compositionVersion: COMPOSITION_VERSION, ts: nowTs(), accountId: acct, mode: s?.mode ?? mode, runMode: mode, accountKind: kind, policyName: policy.policyName, policyDigest, codeDigest: treeDigest, revision: dispatcher.revision(), writerLost: dispatcher.writerLost(), adapter: adapter.kind, credentialsPresent: Boolean(credentials), keyFingerprint: fp, authorization,
      positions: open.map((p) => ({ positionId: p.positionId, pair: p.pair, state: p.state, base: p.confirmedBase, protection: p.protection.state, trigger: p.protection.trigger, firstFillTs: p.firstFillTs, initialR: p.initialR?.value ?? null, structuralStop: p.structuralStop, exit: watch.positions().find((w) => w.positionId === p.positionId)?.exit ?? null })),
      pendingOrders: pending.map((o) => ({ orderId: o.orderId, state: o.state, kind: o.kind })), restrictions: Object.keys(s?.restrictions ?? {}), performance: s?.performance ?? null, valuation: s?.valuation ?? null, cash: s?.cash ?? null, limits: s?.limits ?? null, clock: pclock.status ? pclock.status() : null, feed: fd.status(), judge: judge.status(), decisions: judge.decisions().slice(-12), candidates: judge.candidates().map((c) => ({ symbol: c.symbol, priority: c.priority, readiness: c.readiness ?? null })), preparation: lastPreparation, watch: watch.status(), dispatcher: dispatcher.status(), latency: dispatcher.latency(), cases: cases.status(), recorder: recorder ? recorder.status() : null,
      posture: open.length || pending.some((o) => o.kind === 'ENTRY' || o.kind === 'CANARY_ENTRY') ? (exiting ? 'DIGESTING' : 'STRIKE') : null, exposure: { openPositions: open.length, pendingOrders: pending.length },
      seals: sealsReport({ codeTested: 'SEE_TEST_LOG', paperOperational: mode === 'PAPER' ? 'RUNNING_UNSEALED' : 'NOT_RUN', livePreflight: lastPreflight ? (lastPreflight.ok ? 'PASSED_THIS_PROCESS' : `FAILED:${lastPreflight.reason}`) : 'NOT_RUN', liveArmed: authorization?.active ? 'ARMED_UNEXPIRED' : 'NOT_RUN' }) };
  }
  function publishProjection() { if (!writeProjection) return; try { mkdirSync(judgeDir(), { recursive: true }); atomicWriteJson(projectionFile(), projection()); } catch (err) { log(`projection write failed: ${err.message}`); } }
  let heartbeat = null; let stopped = false; let ticks = 0; let dirty = false; dispatcher.onCommit(() => { dirty = true; });
  async function tick() { const t = nowTs(); if (pclock.observeWall) pclock.observeWall(); ticks += 1; if (ticks % 40 === 1) { try { admitNominations(); } catch (err) { log(`nominations: ${err.message}`); } if (cases.refresh) cases.refresh().catch((err) => log(`cases: ${err.message}`)); for (const c of judge.candidates()) { if (hist.advance) hist.advance(c.symbol, t, { coverage: fd.coverage(c.symbol, t) }); if (hist.needsRefresh && hist.refresh && hist.needsRefresh(c.symbol, t)) hist.refresh(c.symbol).catch((err) => log(`history ${c.symbol}: ${err.message}`)); } } await watch.onTick(t); await judge.onTick(t); if (adapter.onTick) adapter.onTick(t); if (dirty) { dirty = false; publishProjection(); } }
  return {
    compositionVersion: COMPOSITION_VERSION, accountId: acct, mode, kind, policy, policyDigest, codeDigest: treeDigest, journal: jr, writer, dispatcher, feed: fd, tapeFeed, adapter, judge, watch, history: hist, cases, clock: pclock, fee, specOf, credentialsPresent: Boolean(credentials), keyFingerprint: fp, projection, tick, preflight, arm, disarm, admitNominations, checkAuthorizationBinding, lastPreflight: () => lastPreflight,
    registerSpec(spec) { specMap.set(spec.wsname, spec); return spec; },
    async start({ heartbeatMs = 250, projectionMs = 2000 } = {}) { const report = await dispatcher.restart({ scope: 'STARTUP' }); report.authorizationEnded = await checkAuthorizationBinding(); report.executions = null; if (kind === 'LIVE' && adapter.connectExecutions && allowPrivate()) { try { report.executions = await adapter.connectExecutions(); } catch (err) { report.executions = { ok: false, reason: err.message }; } } heartbeat = setInterval(() => { tick().catch((err) => log(`tick: ${err.message}`)); }, heartbeatMs); heartbeat.unref?.(); if (writeProjection) { projectionTimer = setInterval(publishProjection, projectionMs); projectionTimer.unref?.(); publishProjection(); } return report; },
    async stop({ drainMs = 10_000 } = {}) { if (stopped) return null; stopped = true; if (heartbeat) clearInterval(heartbeat); if (projectionTimer) clearInterval(projectionTimer); const closed = await dispatcher.close({ drainMs }); if (recorder) recorder.stop(); publishProjection(); await writer.release(); if (ownDb) await ownDb.end(); return closed; },
    evaluate: (arm = 'REF_COMBINED') => evaluateAccount(dispatcher.state(), { arm }),
  };
}
// owner-intent account initialization (refuses to reset an existing account; no implicit deposit on restart)
export async function initAccount({ journal, policy, policyDigest, mode, ownerRef, nowTs, limits = null, accountId = null }) { const acct = accountId ?? policy.account.accountId; const kind = accountKindOf(mode); if (await journal.exists(acct)) { const l = await journal.load(acct); if (l.state.initialized) throw new JournalError('ACCOUNT_EXISTS', `${acct} is already initialized (revision ${l.revision}); refusing to reset`); } else await journal.create(acct, { accountKind: kind }); const writer = await journal.acquireWriter(acct); if (!writer) throw new JournalError('WRITER_HELD', acct); try { const ev = makeEvent({ type: 'ACCOUNT_INITIALIZED', accountId: acct, knownAtTs: nowTs, payload: { accountKind: kind, initialCapital: policy.account.initialCapital, quote: 'USD', venue: 'kraken', policyDigest, policyVersion: policy.policyName, ownerRef, sessionDate: sessionDate(new Date(nowTs)), clockAnchorTs: nowTs, limits: limits ?? policy.limits, compounding: policy.account.compounding } }); const l = await journal.load(acct); return journal.append(acct, { expectedRevision: l.revision, writerEpoch: writer.epoch, events: [ev] }); } finally { await writer.release(); } }
export { specFromAssetPair, instrumentSpec };
