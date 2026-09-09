// TEST-ONLY outbound guard (focused completion N01/N02). Loaded BEFORE any test module through
//   NODE_OPTIONS="--import=<abs>/test/helpers/offline-guard.mjs"
// and re-injected into every spawned Node child (replaced env objects included). It denies every non-loopback
// connection attempt BEFORE the transport opens — fetch, WebSocket, net / tls (which carry http / https / pg / ws),
// dns resolution and datagrams — and appends one evidence record per attempt to a file OUTSIDE the repository
// (COBRA_OFFLINE_GUARD_LOG; default <tmpdir>/cobra-offline-guard/<run>.jsonl). Records carry host / port / kind /
// pid / test file / top stack frames only: never URLs with query strings, bodies, headers or keys. A caught denial
// is still evidence: the gate checker (offline-gate.mjs) fails on ANY record in the ordinary suite's log. Guard
// self-tests run in separate processes with their own COBRA_OFFLINE_GUARD_RUN identity and log file.
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const GUARD_PATH = fileURLToPath(import.meta.url);
const RUN = process.env.COBRA_OFFLINE_GUARD_RUN ?? 'suite';
const LOG = process.env.COBRA_OFFLINE_GUARD_LOG ?? path.join(tmpdir(), 'cobra-offline-guard', `${RUN.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
process.env.COBRA_OFFLINE_GUARD_LOG = LOG; process.env.COBRA_OFFLINE_GUARD_RUN = RUN;
const LOOPBACK_RE = /^(127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1|::ffff:127(\.\d{1,3}){3}|localhost|0\.0\.0\.0|::)$/i;
export const isLoopbackHost = (host) => { if (host === undefined || host === null || host === '') return true; const h = String(host).replace(/^\[|\]$/g, '').toLowerCase(); return LOOPBACK_RE.test(h); };
const testFile = () => { const a = process.argv.find((x) => /\.test\.(m?js|cjs)$/.test(x)); return a ? path.basename(a) : null; };
export function recordDenial(kind, host, port) {
  const stack = String(new Error().stack ?? '').split('\n').slice(2, 8).map((l) => l.trim()).filter((l) => !l.includes('offline-guard.mjs')).slice(0, 3);
  const rec = { ts: new Date().toISOString(), run: RUN, pid: process.pid, ppid: process.ppid, kind, host: host === undefined ? null : String(host).slice(0, 120), port: port === undefined ? null : Number(port) || null, testFile: testFile(), stack };
  try { mkdirSync(path.dirname(LOG), { recursive: true }); appendFileSync(LOG, `${JSON.stringify(rec)}\n`); } catch { /* the denial stands even if the evidence file is unwritable */ }
  const err = new Error(`OFFLINE_GUARD_DENIED: ${kind} to ${rec.host ?? '?'}${rec.port ? `:${rec.port}` : ''} (test run is offline)`); err.code = 'OFFLINE_GUARD_DENIED'; err.kind = kind; err.host = rec.host; err.port = rec.port; return err;
}
// ---- net.Socket.connect (net / tls / http / https / pg / ws): deny before the socket opens, fail like a refused peer ----
const connectTarget = (args) => { let a = args[0]; if (Array.isArray(a)) a = a[0]; /* net.connect passes its normalized [options, cb] array */ if (a && typeof a === 'object' && !Array.isArray(a)) { if (a.path) return { unix: true }; return { host: a.host ?? 'localhost', port: a.port }; } if (typeof a === 'string' && !/^\d+$/.test(a)) return { unix: true }; return { port: Number(a), host: typeof args[1] === 'string' ? args[1] : 'localhost' }; };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) { const t = connectTarget(args); if (!t.unix && !isLoopbackHost(t.host)) { const err = recordDenial('SOCKET', t.host, t.port); process.nextTick(() => this.destroy(err)); return this; } return origConnect.apply(this, args); };
// ---- dns: resolution of a non-loopback name is itself an outbound attempt ----
const denyLookup = (hostname) => (isLoopbackHost(hostname) ? null : recordDenial('DNS', hostname, null));
const origLookup = dns.lookup; dns.lookup = function guardedLookup(hostname, ...rest) { const err = denyLookup(hostname); if (err) { const cb = rest.find((x) => typeof x === 'function'); if (cb) { process.nextTick(() => cb(err)); return undefined; } throw err; } return origLookup.call(dns, hostname, ...rest); };
const origLookupP = dns.promises.lookup; dns.promises.lookup = async function guardedLookupP(hostname, ...rest) { const err = denyLookup(hostname); if (err) throw err; return origLookupP.call(dns.promises, hostname, ...rest); };
for (const fn of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt', 'resolveSrv', 'resolveNs']) { const o = dns[fn]; if (typeof o === 'function') dns[fn] = function guardedResolve(hostname, ...rest) { const err = denyLookup(hostname); if (err) { const cb = rest.find((x) => typeof x === 'function'); if (cb) { process.nextTick(() => cb(err)); return undefined; } throw err; } return o.call(dns, hostname, ...rest); }; const p = dns.promises[fn]; if (typeof p === 'function') dns.promises[fn] = async function guardedResolveP(hostname, ...rest) { const err = denyLookup(hostname); if (err) throw err; return p.call(dns.promises, hostname, ...rest); }; }
// ---- datagrams ----
const origSend = dgram.Socket.prototype.send; dgram.Socket.prototype.send = function guardedSend(...args) { const addr = args.find((x, i) => i >= 1 && typeof x === 'string' && !/^\d+$/.test(x)) ?? (typeof args[3] === 'string' ? args[3] : undefined); const port = args.find((x, i) => i >= 1 && typeof x === 'number'); if (addr !== undefined && !isLoopbackHost(addr)) { const err = recordDenial('DGRAM', addr, port); const cb = args.find((x) => typeof x === 'function'); if (cb) process.nextTick(() => cb(err)); else this.emit('error', err); return undefined; } return origSend.apply(this, args); };
const origDgramConnect = dgram.Socket.prototype.connect; if (typeof origDgramConnect === 'function') dgram.Socket.prototype.connect = function guardedDgramConnect(port, address, cb) { const a = typeof address === 'string' ? address : 'localhost'; if (!isLoopbackHost(a)) { const err = recordDenial('DGRAM', a, port); const f = typeof address === 'function' ? address : cb; if (f) process.nextTick(() => f(err)); else process.nextTick(() => this.emit('error', err)); return undefined; } return origDgramConnect.call(this, port, address, cb); };
// ---- fetch ----
const hostOf = (input) => { try { const u = new URL(typeof input === 'string' ? input : input?.url ?? String(input)); return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80, protocol: u.protocol }; } catch { return { host: null, port: null, protocol: null }; } };
if (typeof globalThis.fetch === 'function') { const origFetch = globalThis.fetch; globalThis.fetch = async function guardedFetch(input, init) { const { host, protocol } = hostOf(input); if (host !== null && /^https?:$/.test(protocol) && !isLoopbackHost(host)) { const err = recordDenial('FETCH', host, hostOf(input).port); const te = new TypeError('fetch failed'); te.cause = err; te.code = 'OFFLINE_GUARD_DENIED'; throw te; } return origFetch.call(this, input, init); }; }
// ---- WebSocket: a denied socket never opens; it reports error + close asynchronously like a refused peer ----
if (typeof globalThis.WebSocket === 'function') {
  const OrigWS = globalThis.WebSocket;
  class DeniedWebSocket extends EventTarget { constructor(url, err) { super(); this.url = String(url); this.readyState = 3; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; process.nextTick(() => { const e = new Event('error'); e.error = err; e.message = err.message; this.onerror?.(e); this.dispatchEvent(e); const c = new Event('close'); c.code = 1006; c.reason = 'OFFLINE_GUARD_DENIED'; c.wasClean = false; this.onclose?.(c); this.dispatchEvent(c); }); } send() { throw new Error('OFFLINE_GUARD_DENIED: socket never opened'); } close() {} }
  const GuardedWebSocket = function GuardedWebSocket(url, protocols) { const { host, port } = hostOf(url); if (host !== null && !isLoopbackHost(host)) return new DeniedWebSocket(url, recordDenial('WEBSOCKET', host, port)); return new OrigWS(url, protocols); };
  GuardedWebSocket.prototype = OrigWS.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) GuardedWebSocket[k] = OrigWS[k]; globalThis.WebSocket = GuardedWebSocket;
}
// ---- child processes: a Node child with a replaced env still carries the guard (NODE_OPTIONS --import) ----
const IMPORT_FLAG = `--import=${GUARD_PATH}`;
export function guardedEnv(env) { const base = env && typeof env === 'object' ? { ...env } : { ...process.env }; const opts = String(base.NODE_OPTIONS ?? ''); if (!opts.includes(GUARD_PATH)) base.NODE_OPTIONS = `${opts} ${IMPORT_FLAG}`.trim(); if (!base.COBRA_OFFLINE_GUARD_LOG) base.COBRA_OFFLINE_GUARD_LOG = LOG; if (!base.COBRA_OFFLINE_GUARD_RUN) base.COBRA_OFFLINE_GUARD_RUN = RUN; return base; }
const withEnv = (args, idx) => { const opts = args[idx]; if (opts && typeof opts === 'object' && !Array.isArray(opts) && typeof opts !== 'function') { args[idx] = { ...opts, env: guardedEnv(opts.env) }; } else { args.splice(idx, 0, { env: guardedEnv(undefined) }); } return args; };
const optionsIndex = (args, from) => { for (let i = from; i < args.length; i += 1) { if (typeof args[i] === 'function') return i; if (args[i] && typeof args[i] === 'object' && !Array.isArray(args[i])) return i; } return args.length; };
function wrapSpawnLike(name) { const orig = childProcess[name]; if (typeof orig !== 'function') return; const wrapped = function guardedSpawnLike(...args) { const a = [...args]; return orig.apply(childProcess, withEnv(a, optionsIndex(a, 1))); }; if (orig[promisify.custom]) { const oc = orig[promisify.custom]; wrapped[promisify.custom] = function guardedPromisified(...args) { const a = [...args]; return oc.apply(childProcess, withEnv(a, optionsIndex(a, 1))); }; } childProcess[name] = wrapped; }
for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrapSpawnLike(n);
syncBuiltinESMExports(); // ESM named imports of the builtins see the guarded functions
export const OFFLINE_GUARD = Object.freeze({ path: GUARD_PATH, log: LOG, run: RUN, version: 'cobra-offline-guard-1' });
