// SERPENT PAPER — the DARK research capture runner: repeated bounded edge-capture segments (Kraken Futures Charts + Kraken L3)
// under the paper market-research policy, sealed into EDGE_CAPTURE bundles under <research-root>/edge-captures/<segment>.
// It is composed by paper/launch.js ONLY (fly.js never names a dark module); its status file is the ONLY thing the cockpit /
// preflight read. Authority NONE: nothing here reaches Socrates, the Judge, the Watch or execution; the L3 socket opens only
// on a proven SAFE_L3_DATA_KEY (kraken-l3-auth.js law); a missing / unusable key is BLOCKED_NO_SAFE_L3_DATA_KEY, a dark-sense
// blocker, never a PAPER readiness blocker. States: DARK_CAPTURE_OPERATIONAL | DARK_CAPTURE_BLOCKED_EXTERNAL |
// DARK_CAPTURE_DEGRADED | DARK_CAPTURE_DISABLED_BY_POLICY — none of them implies edge success.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { chartsEnabled, l3Enabled } from '../market-lab/policy.js';
import { runEdgeCapture } from '../market-lab/edge-capture.js';

export const DARK_CAPTURE_VERSION = 'serpent-dark-capture-1';
export const DARK_CAPTURE_STATES = Object.freeze(['DARK_CAPTURE_OPERATIONAL', 'DARK_CAPTURE_BLOCKED_EXTERNAL', 'DARK_CAPTURE_DEGRADED', 'DARK_CAPTURE_DISABLED_BY_POLICY']);
export const STATUS_FILE = 'edge-capture-status.json';
export const SEGMENTS_DIR = 'edge-captures';
export const DEFAULT_SEGMENT_SECONDS = 3600;
export const FAILURE_BACKOFF_MS = 60_000;
const writeAtomic = (file, obj) => { mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; writeFileSync(tmp, `${JSON.stringify(obj, null, 1)}\n`); renameSync(tmp, file); };
const nonsecret = (r) => (r ? { ok: r.ok, capture: r.capture ?? null, error: r.error ?? null, counters: r.counters ?? null, charts: r.charts ? { symbols: r.charts.symbols, polls: r.charts.polls, calls: r.charts.calls, failures: r.charts.failures, partialAcquisitions: r.charts.partialAcquisitions ?? 0, lastFailureKind: r.charts.lastFailureKind ?? null } : null, l3: r.l3 ? { markets: r.l3.markets, verdict: r.l3.verdict, blocker: r.l3.blocker ?? null, keyFingerprint: r.l3.keyFingerprint ?? null, started: r.l3.started, streamAdmitted: r.l3.streamAdmitted ?? null } : null, bundleId: r.bundleId ?? null, manifestSha256: r.manifestSha256 ?? null, outputDir: r.outputDir ?? null } : null);
export function darkStateOf({ chartsOn, l3On, last }) {
  if (!chartsOn && !l3On) return 'DARK_CAPTURE_DISABLED_BY_POLICY';
  if (!last) return 'DARK_CAPTURE_DEGRADED';
  const chartsBlocked = chartsOn && last.charts && last.charts.calls === 0 && last.charts.failures > 0; const chartsPartial = chartsOn && last.charts && (last.charts.failures > 0 || (last.charts.partialAcquisitions ?? 0) > 0);
  const l3Blocked = l3On && last.l3 && !last.l3.started; const anySense = (chartsOn && last.charts && last.charts.calls > 0) || (l3On && last.l3?.started);
  if (!last.ok) return anySense ? 'DARK_CAPTURE_DEGRADED' : 'DARK_CAPTURE_BLOCKED_EXTERNAL';
  if (!anySense && (chartsBlocked || l3Blocked)) return 'DARK_CAPTURE_BLOCKED_EXTERNAL';
  if (chartsPartial || l3Blocked || last.capture === 'PARTIAL') return 'DARK_CAPTURE_DEGRADED';
  return 'DARK_CAPTURE_OPERATIONAL';
}
export function startDarkCapture({ policy, subjects, env = process.env, researchRoot, segmentSeconds = DEFAULT_SEGMENT_SECONDS, log = () => {}, clock = () => Date.now(), fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, wsUrls = {} }) {
  if (typeof researchRoot !== 'string' || !researchRoot.length) throw new Error('dark capture needs the research root');
  const chartsOn = chartsEnabled(policy); const l3On = l3Enabled(policy); const statusFile = path.join(researchRoot, STATUS_FILE);
  let stopped = false; let running = null; let last = null; let segments = 0; let failures = 0; let lastSealTs = null; const waiters = new Set();
  const sleep = (ms) => new Promise((resolve) => { if (stopped) { resolve(); return; } const t = timers.setTimeout(() => { waiters.delete(w); resolve(); }, ms); const w = () => { timers.clearTimeout(t); resolve(); }; waiters.add(w); });
  const wake = () => { for (const w of [...waiters]) { waiters.delete(w); w(); } };
  const status = () => ({ version: DARK_CAPTURE_VERSION, tsMs: clock(), state: darkStateOf({ chartsOn, l3On, last }), chartsEnabled: chartsOn, l3Enabled: l3On, segmentSeconds, segments, failures, lastSealTs, running: running !== null && !stopped, capture: last?.capture ?? null, charts: last?.charts ?? null, l3: last?.l3 ?? null, lastError: last?.error ?? null, lastBundleId: last?.bundleId ?? null, edgeClaim: 'NOT_MADE', authority: 'NONE', consumers: 'EDGE_CAPTURE only (never Socrates / Judge / Watch / execution)' });
  const publish = () => { try { writeAtomic(statusFile, status()); } catch (err) { log(`dark capture status write failed: ${String(err?.message ?? err).slice(0, 120)}`); } };
  async function loop() {
    if (!chartsOn && !l3On) { publish(); log('DARK CAPTURE disabled by the paper policy (charts / l3 off)'); return; }
    log(`DARK CAPTURE starting (research only; authority NONE): charts ${chartsOn ? 'on' : 'off'}, L3 ${l3On ? 'requested (SAFE_L3_DATA_KEY gate)' : 'off'}, segments of ${segmentSeconds}s`);
    while (!stopped) {
      // the segments directory is the runner's own (the capture command refuses a segment whose parent is missing)
      try { mkdirSync(path.join(researchRoot, SEGMENTS_DIR), { recursive: true }); } catch (err) { log(`DARK CAPTURE cannot create the segments directory: ${String(err?.message ?? err).slice(0, 120)}`); }
      const out = path.join(researchRoot, SEGMENTS_DIR, `seg-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}`);
      let r = null;
      try { r = await runEdgeCapture({ policy, subjects, env, out, durationSeconds: segmentSeconds, clock, fetchImpl, WebSocketImpl, wsUrls, log, sleep, researchRoot, timers }); }
      catch (err) { r = { ok: false, error: { code: err?.code ?? 'INTERNAL_FAILURE', message: String(err?.message ?? err).slice(0, 160) }, capture: null, charts: null, l3: null }; }
      last = nonsecret(r); if (r.ok) { segments += 1; lastSealTs = clock(); } else failures += 1;
      publish();
      log(`DARK CAPTURE segment ${r.ok ? 'sealed' : 'failed'}: ${darkStateOf({ chartsOn, l3On, last })}${last.l3 ? ` (L3 ${last.l3.verdict}${last.l3.blocker ? ' / ' + last.l3.blocker : ''})` : ''}${last.error ? ` error ${last.error.code}` : ''}`);
      if (!stopped && !r.ok) await sleep(FAILURE_BACKOFF_MS);
    }
  }
  return {
    start() { if (running) return running; publish(); running = loop().catch((err) => { log(`DARK CAPTURE loop failed (contained): ${String(err?.message ?? err).slice(0, 160)}`); }); return running; },
    async stop() { stopped = true; wake(); if (running) await running; publish(); },
    status, statusFile, sleep,
  };
}
