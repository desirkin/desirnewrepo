// lib/boot-self-check.js — PUBLISH-FIX-9 (2026-09-16): the boot says what it is running on, then reports memory every minute.
//
// Production boot f7173376 froze 27 s after TAPE LIVE at heap=515MB: V8's default old-space ceiling on a 2 GiB machine
// is ~512MB, so the process hit its own ceiling, spent every cycle collecting garbage, stopped answering the health
// check, lost its PostgreSQL socket and crashed — and nothing in the log said why. This module prints, at boot, the
// facts a stalled deployment needs to explain itself (heap ceiling, node version, database HOST by name, which secret
// NAMES are present) and then one memory line a minute. Names only, never values; nothing here has any authority.
import v8 from 'node:v8';

export const MEMORY_REPORT_INTERVAL_MS = 60_000;
// Secret NAMES the paper boot cares about (presence only). Never a value, never logged beyond present/absent.
export const SECRET_NAMES = Object.freeze([
  'DATABASE_URL', 'SERPENT_CONTROL_PASSWORD', 'SESSION_SECRET', 'SERPENT_PAPER_INIT_ACCOUNT', 'SERPENT_HTTP_CONTACT',
  'COINGECKO_DEMO_API_KEY', 'CRYPTOQUANT_API_KEY', 'COINGLASS_API_KEY', 'TOKENOMIST_API_KEY', 'ANTHROPIC_API_KEY',
  'X_BEARER_TOKEN', 'NEYNAR_API_KEY', 'SERPENT_OBJECT_STORE_PROVIDER', 'SERPENT_OBJECT_STORE_BUCKET',
]);

const mb = (bytes) => Math.round(bytes / 1048576);

// host:port/database of a connection URL — never the user, never the password, never the query string
export function databaseHostOf(url) {
  if (typeof url !== 'string' || !url.length) return 'unset';
  try { const u = new URL(url); return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || ''}`; }
  catch { return 'unparseable'; }
}

export function bootSelfCheck({ env = process.env, memory = process.memoryUsage(), heapLimitBytes = v8.getHeapStatistics().heap_size_limit, nodeVersion = process.version, execArgv = process.execArgv } = {}) {
  const nodeOptionsFlag = (env.NODE_OPTIONS ?? '').split(/\s+/).find((a) => a.startsWith('--max-old-space-size')) ?? null;
  const present = SECRET_NAMES.filter((n) => typeof env[n] === 'string' && env[n].length > 0);
  const absent = SECRET_NAMES.filter((n) => !present.includes(n));
  return Object.freeze({
    node: nodeVersion,
    heapLimitMb: mb(heapLimitBytes),
    heapUsedMb: mb(memory.heapUsed),
    rssMb: mb(memory.rss),
    heapFlag: execArgv.find((a) => a.startsWith('--max-old-space-size')) ?? nodeOptionsFlag,
    databaseHost: databaseHostOf(env.DATABASE_URL),
    dataGeneration: env.SERPENT_DATA_GENERATION ?? 'unset',
    profile: env.COBRA_PROFILE ?? 'unset',
    judgeMode: env.JUDGE_MODE ?? 'unset',
    secretsPresent: present,
    secretsAbsent: absent,
  });
}

export function logBootSelfCheck({ env = process.env, log = () => {} } = {}) {
  const c = bootSelfCheck({ env });
  log(`BOOT SELF-CHECK: node ${c.node} · heap limit ${c.heapLimitMb}MB${c.heapFlag ? ` (${c.heapFlag})` : ' (V8 default — no --max-old-space-size)'} · heap ${c.heapUsedMb}MB rss ${c.rssMb}MB · database ${c.databaseHost} · generation ${c.dataGeneration} · profile ${c.profile} · JUDGE_MODE ${c.judgeMode}`);
  log(`BOOT SELF-CHECK: secrets present [${c.secretsPresent.join(', ')}] · absent [${c.secretsAbsent.join(', ')}]`);
  if (c.heapLimitMb < 1024) log(`BOOT SELF-CHECK WARNING: heap limit ${c.heapLimitMb}MB is below 1024MB — the paper tape froze at 515MB on 2026-09-16; set NODE_OPTIONS=--max-old-space-size=1400 for the deployment`);
  return c;
}

export function memoryLine({ memory = process.memoryUsage(), heapLimitBytes = v8.getHeapStatistics().heap_size_limit } = {}) {
  const used = mb(memory.heapUsed); const limit = mb(heapLimitBytes);
  return `MEM heap ${used}/${limit}MB (${Math.round((used / Math.max(1, limit)) * 100)}%) rss ${mb(memory.rss)}MB external ${mb(memory.external)}MB`;
}

export function startMemoryReport({ log = () => {}, intervalMs = MEMORY_REPORT_INTERVAL_MS, timers = globalThis } = {}) {
  const t = timers.setInterval(() => { try { log(memoryLine()); } catch { /* reporting never throws into the boot */ } }, intervalMs);
  if (typeof t?.unref === 'function') t.unref();
  return { stop: () => timers.clearInterval(t) };
}
