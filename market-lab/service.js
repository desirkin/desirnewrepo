// MARKET LAB — the research SERVICE (§12 serve / fly.js opt-in): one research owner (rolling acquisition under the
// policy), one case runtime (queued cases under the case ceilings), a read-only status file and an optional loopback
// HTTP status/report endpoint. It never starts application execution or order loops; it exposes nothing that trades.
// Standalone mode streams the venues itself; integrated mode (fly.js) receives accepted Tape observations through the
// owner's observer and reads the detached Social projection accessor. Stop / signal handling seals the capture segment,
// closes the budget journal and releases the port; a failing case never hangs the process.
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, openSync, closeSync, renameSync, readdirSync, existsSync, readFileSync, fsyncSync } from 'node:fs';
import { deepFreeze, fail, canonicalJson, sha256Hex } from './contracts.js';
import { RESOURCE_DEFAULTS } from './policy.js';
import { createResearchOwner } from './owner.js';
import { marketResearchRootFromEnv, CASE_DIR_NAME_RE } from './paths.js';
import { writeAll, directoryBytes, quotaState } from './store.js';
import { providerReadiness, liveReadinessManifest } from './readiness.js';
import { buildContext } from './context.js';
import { buildResearchEvidenceV2, buildEmptyResearchPacket } from '../evidence/research-builder.js';
import { buildSocialProjection } from '../evidence/social-projection.js';
import { createCaseRuntime, ownerContextRebuilder, TERMINAL_STATES } from '../socrates/runtime.js';

export const SERVICE_VERSION = 'market-research-service-1';
export const SERVICE_STATES = Object.freeze(['CREATED', 'STARTING', 'ACTIVE', 'STOPPING', 'STOPPED', 'FAILED']);
export { marketResearchRootFromEnv };
const CASE_DIR_RE = CASE_DIR_NAME_RE;

function writeAtomic(file, text) { const tmp = `${file}.${process.pid}.tmp`; let fd = null; try { fd = openSync(tmp, 'w'); writeAll(fd, Buffer.from(text, 'utf8'), path.basename(file)); fsyncSync(fd); closeSync(fd); fd = null; renameSync(tmp, file); } catch (err) { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } throw err; } }

export function createResearchService({ policy, subjects, env = {}, researchRoot, mode = 'STANDALONE', clock = () => Date.now(), log = () => {}, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wsUrls = {}, settledAccessors = {}, socialSource = null, timers = { setInterval, clearInterval, setTimeout, clearTimeout }, httpPort = null, httpHost = '127.0.0.1', caseEverySeconds = null, families = null, rotation = null, limits = RESOURCE_DEFAULTS } = {}) {
  if (typeof researchRoot !== 'string' || !researchRoot.length) fail('INVALID_REQUEST', 'a research root directory is required');
  const root = path.resolve(researchRoot); const casesDir = path.join(root, 'cases'); const capturesDir = path.join(root, 'captures'); const budgetDir = path.join(root, 'budget'); const statusFile = path.join(root, 'status.json');
  let state = 'CREATED'; let server = null; let boundPort = null; let statusTimer = null; let caseTimer = null; let stopping = null; const startedTs = clock(); let lastError = null;
  const caseIndex = []; // { caseId, dir, status, canonicalCoin, createdTs, finishedTs, analysisId }
  const queue = []; let running = 0; const counters = { enqueued: 0, started: 0, completed: 0, refused: 0, failed: 0 };
  // the detached Social projection: the raw accessor (composite view + latest dossier record) becomes the closed DTO here
  const socialProjection = socialSource ? (coin, { asOfTs }) => { let raw = null; try { raw = socialSource(coin, { asOfTs }); } catch { raw = null; } return buildSocialProjection({ canonicalCoin: coin, asOfTs, composite: raw?.composite ?? null, dossierRecord: raw?.dossierRecord ?? null, connected: raw !== null && raw.connected !== false }); } : null;
  const owner = createResearchOwner({ policy, subjects, env, researchRoot: root, mode, clock, log, fetchImpl, WebSocketImpl, wsUrls, settledAccessors, socialProjection, timers });
  const runtime = createCaseRuntime({ policy, env, owner, clock, log, fetchImpl, budgetDir, contextRebuilder: ownerContextRebuilder(owner, { referenceNotionals: subjects.referenceNotionals ?? [1000, 10000], limits }), socialProjectionOf: socialProjection ? ({ canonicalCoin, asOfTs }) => { try { return socialProjection(canonicalCoin, { asOfTs }); } catch { return null; } } : null, mode: policy.mode });
  const quota = () => { try { return quotaState(directoryBytes(root), policy.resources?.researchRootQuotaBytes ?? limits.researchRootQuotaBytes); } catch { return null; } };

  // ---- one case: context at now from the owner's retained observations -> packet (+ Social projection) -> runtime -> sealed dir
  async function runQueued(item) {
    running += 1; counters.started += 1; const asOfTs = clock(); let entry = null;
    try {
      const obs = owner.observations(); const cov = owner.coverage(); const peers = [...new Set(obs.filter((o) => o.kind === 'TRADE' && o.subject.canonicalCoin !== item.canonicalCoin).map((o) => o.subject.canonicalCoin))].sort();
      let context = null; try { context = buildContext({ canonicalCoin: item.canonicalCoin, asOfTs, observations: obs, coverage: cov, captureRef: { bundleId: 'live-owner', manifestSha256: 'live', observationsSha256: 'live', coverageSha256: 'live' }, referenceNotionals: subjects.referenceNotionals ?? [1000, 10000], peers, limits, resourceState: owner.hot?.status?.() ?? null }).context; } catch (err) { log(`context build failed for ${item.canonicalCoin}: ${String(err?.message ?? err).slice(0, 120)}`); }
      let social = null; if (socialProjection) { try { social = socialProjection(item.canonicalCoin, { asOfTs: context?.asOfTs ?? asOfTs }) ?? null; } catch { social = null; } }
      const trigger = item.trigger ?? { kind: social ? 'RESEARCH_DOSSIER' : 'MARKET_RESEARCH', sourceEventId: item.sourceEventId ?? null, observedTs: item.observedTs ?? null };
      const built = context || social ? buildResearchEvidenceV2({ marketContext: context, socialProjection: social, asOfTs, trigger, mode: policy.mode, entrances: item.entrances ?? null }) : buildEmptyResearchPacket({ canonicalCoin: item.canonicalCoin, asOfTs, trigger, mode: policy.mode });
      if (!built.ok) { counters.failed += 1; entry = { caseId: null, dir: null, status: 'PACKET_BUILD_FAILED', canonicalCoin: item.canonicalCoin, createdTs: asOfTs, finishedTs: clock(), reason: `${built.reason}: ${JSON.stringify(built.detail ?? null).slice(0, 160)}`, analysisId: null }; caseIndex.push(entry); return entry; }
      const caseId = runtime.caseIdentity(built.packet); const dir = path.join(casesDir, `${caseId}-${String(asOfTs).padStart(13, '0')}`);
      const handle = runtime.runCase({ packet: built.packet, marketContext: context, socialProjection: social, out: dir, contextMap: built.contextMap });
      entry = { caseId, dir, status: 'RUNNING', canonicalCoin: item.canonicalCoin, createdTs: asOfTs, finishedTs: null, analysisId: null, reason: item.reason ?? null }; caseIndex.push(entry);
      const r = await handle.done; entry.status = r.status; entry.finishedTs = r.manifest.timing.finishedTs; entry.analysisId = r.analysis?.analysisId ?? null; entry.diagnostic = r.manifest.diagnostic?.kind ?? null; counters.completed += 1; return entry;
    } catch (err) { counters.failed += 1; lastError = String(err?.message ?? err).slice(0, 200); if (entry) { entry.status = 'FAILED'; entry.finishedTs = clock(); entry.diagnostic = lastError; } log(`case failed: ${lastError}`); return entry; }
    finally { running -= 1; drain(); }
  }
  function drain() { while (queue.length && running < policy.cases.maxConcurrentModelRequests && state === 'ACTIVE') { const item = queue.shift(); runQueued(item).catch(() => {}); } }
  // enqueue: a duplicate pending subject returns the existing pending item; the pending ceiling refuses honestly
  function enqueueCase({ canonicalCoin, trigger = null, reason = null, entrances = null, sourceEventId = null, observedTs = null } = {}) {
    if (state !== 'ACTIVE') return { accepted: false, reason: 'SERVICE_NOT_ACTIVE' };
    if (!subjects.subjects.some((s) => s.canonicalCoin === canonicalCoin)) return { accepted: false, reason: 'SUBJECT_NOT_DECLARED' };
    const pending = queue.find((q) => q.canonicalCoin === canonicalCoin); if (pending) return { accepted: true, duplicate: true, position: queue.indexOf(pending) };
    if (queue.length + running >= policy.cases.maxPendingCases) { counters.refused += 1; return { accepted: false, reason: 'PENDING_CEILING' }; }
    const position = queue.push({ canonicalCoin, trigger, reason, entrances, sourceEventId, observedTs, enqueuedTs: clock() }) - 1; counters.enqueued += 1; drain(); return { accepted: true, duplicate: false, position };
  }
  function status() {
    const ownerStatus = owner.status();
    return deepFreeze({ serviceVersion: SERVICE_VERSION, state, mode, policyMode: policy.mode, startedTs, nowTs: clock(), researchRoot: root, http: boundPort ? { host: httpHost, port: boundPort } : null, quota: quota(), owner: { started: ownerStatus.started, stopped: ownerStatus.stopped, counters: ownerStatus.counters, hot: ownerStatus.hot, streams: ownerStatus.streams, clients: Object.fromEntries(Object.entries(ownerStatus.clients).map(([k, v]) => [k, { runtime: v.runtime, requests: v.counters?.requests ?? 0, ok: v.counters?.ok ?? 0, failed: v.counters?.failed ?? 0, lastFailure: v.lastFailure ?? null }])) }, cases: { queued: queue.length, running, counters: { ...counters }, recent: caseIndex.slice(-32).map((c) => ({ caseId: c.caseId, status: c.status, canonicalCoin: c.canonicalCoin, createdTs: c.createdTs, finishedTs: c.finishedTs, analysisId: c.analysisId, dir: c.dir ? path.basename(c.dir) : null, reason: c.reason ?? null, diagnostic: c.diagnostic ?? null })) }, runtime: runtime.status(), model: { enabled: policy.model.enabled, model: policy.model.model, credentialEnv: policy.model.credentialEnv, credentialPresent: typeof env[policy.model.credentialEnv] === 'string' && env[policy.model.credentialEnv].length > 0, caps: { perCase: policy.model.maxEstimatedUsdPerCase, perDay: policy.model.maxEstimatedUsdPerDay, perMonth: policy.model.maxEstimatedUsdPerMonth } }, lastError, authority: 'NONE', purpose: 'RESEARCH_ONLY' });
  }
  function readiness() { const rows = providerReadiness({ policy, env, clientStatus: owner.status().clients }); return liveReadinessManifest({ rows, familyCoverage: null, modelReadiness: { enabled: policy.model.enabled, credentialPresent: typeof env[policy.model.credentialEnv] === 'string' && env[policy.model.credentialEnv].length > 0 }, generatedTs: clock() }); }
  function writeStatus() { try { writeAtomic(statusFile, `${JSON.stringify(status(), null, 1)}\n`); } catch (err) { log(`status write failed: ${String(err?.message ?? err).slice(0, 120)}`); } }
  function caseFile(caseDirName, member) { if (!CASE_DIR_RE.test(caseDirName)) return null; const file = path.join(casesDir, caseDirName, member); if (!existsSync(path.join(casesDir, caseDirName, 'manifest.json')) || !existsSync(file)) return null; return readFileSync(file); }
  function listCases() { try { return readdirSync(casesDir).filter((d) => CASE_DIR_RE.test(d) && existsSync(path.join(casesDir, d, 'manifest.json'))).sort(); } catch { return []; } }
  // ---- read-only loopback HTTP: status / readiness / cases / case manifest / report ---------------------------------------
  function handle(req, res) {
    const send = (code, body, type = 'application/json') => { const buf = Buffer.from(type === 'application/json' ? `${JSON.stringify(body)}\n` : body); res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length }); res.end(buf); };
    if (req.method !== 'GET') return send(405, { ok: false, error: 'read-only service' });
    const url = new URL(req.url, `http://${httpHost}`); const p = url.pathname;
    if (p === '/status') return send(200, status()); if (p === '/readiness') return send(200, readiness()); if (p === '/cases') return send(200, { cases: listCases(), recent: status().cases.recent });
    const m = p.match(/^\/cases\/([^/]+)(?:\/(report|manifest|case))?$/); if (m) { const member = m[2] === 'report' ? 'report.md' : m[2] === 'manifest' ? 'manifest.json' : 'case.json'; const buf = caseFile(m[1], member); if (!buf) return send(404, { ok: false, error: 'no such sealed case' }); return send(200, buf, member.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json'); }
    return send(404, { ok: false, error: 'not found' });
  }
  async function start() {
    if (state !== 'CREATED') fail('INVALID_REQUEST', `service cannot start from ${state}`); state = 'STARTING';
    mkdirSync(casesDir, { recursive: true }); mkdirSync(capturesDir, { recursive: true }); mkdirSync(budgetDir, { recursive: true });
    const q = quota(); if (q && q.exhausted) { state = 'FAILED'; fail('RESOURCE_LIMIT_EXCEEDED', 'research root quota exhausted'); }
    const segmentDir = path.join(capturesDir, `cap-${String(startedTs).padStart(13, '0')}`);
    try { await owner.start({ outDir: segmentDir, families, rotation }); } catch (err) { state = 'FAILED'; lastError = String(err?.message ?? err).slice(0, 200); throw err; }
    if (httpPort !== null) { await new Promise((resolve, reject) => { server = http.createServer(handle); server.on('error', reject); server.listen(httpPort, httpHost, () => { boundPort = server.address().port; resolve(); }); }); }
    state = 'ACTIVE'; writeStatus(); statusTimer = timers.setInterval(writeStatus, 5000); statusTimer.unref?.();
    if (caseEverySeconds) { const tick = () => { for (const s of subjects.subjects) enqueueCase({ canonicalCoin: s.canonicalCoin, reason: 'SCHEDULED' }); }; caseTimer = timers.setInterval(tick, caseEverySeconds * 1000); caseTimer.unref?.(); }
    return { state, http: boundPort ? { host: httpHost, port: boundPort } : null, segmentDir };
  }
  async function stop({ seal = true } = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      state = 'STOPPING'; if (statusTimer) timers.clearInterval(statusTimer); if (caseTimer) timers.clearInterval(caseTimer); queue.length = 0;
      if (server) await new Promise((resolve) => server.close(() => resolve())); server = null;
      const sealed = await owner.stop({ seal, policyNonsecret: policy }); runtime.close(); state = 'STOPPED'; writeStatus();
      return { state, sealed: sealed.sealed ? { bundleId: sealed.sealed.manifest.bundleId, dir: sealed.sealed.dir ?? null } : null, error: sealed.error ?? null };
    })();
    return stopping;
  }
  return { start, stop, enqueueCase, status, readiness, owner, runtime, observer: owner.observer, listCases, caseFile, paths: { root, casesDir, capturesDir, budgetDir, statusFile }, isActive: () => state === 'ACTIVE', terminal: TERMINAL_STATES };
}
export const statusDigest = (s) => sha256Hex(Buffer.from(canonicalJson(s), 'utf8'));
