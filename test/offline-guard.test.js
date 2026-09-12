// N01 — the test-only outbound guard, exercised in SEPARATE isolated processes with their own evidence log and
// `selftest:` run identity: every external route is denied BEFORE the transport opens (fetch, WebSocket, net, tls,
// dns, datagrams), a caught denial is still recorded, loopback HTTP works, a Node child with a REPLACED env inherits
// the guard and keeps its promisified stdout contract. The ordinary suite's own log must stay empty (offline-gate.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const execFileP = promisify(execFile);
const GUARD = path.resolve('test/helpers/offline-guard.mjs'); const TMP = mkdtempSync(path.join(tmpdir(), 'cobra-guard-selftest-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
// one isolated child per scenario: a fresh evidence file, a selftest run identity, the guard preloaded through NODE_OPTIONS only
async function isolated(name, script, { env = {} } = {}) {
  const log = path.join(TMP, `${name}.jsonl`); const file = path.join(TMP, `${name}.mjs`); writeFileSync(file, script);
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--import=${GUARD}`, COBRA_OFFLINE_GUARD_LOG: log, COBRA_OFFLINE_GUARD_RUN: `selftest:${name}:${randomUUID().slice(0, 8)}`, ...env };
  let out; try { out = await execFileP(process.execPath, [file], { env: childEnv, timeout: 30_000 }); } catch (err) { out = { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code, failed: true }; }
  const records = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...out, records, log };
}
const summary = (r) => r.records.map((x) => `${x.kind} ${x.host}:${x.port}`);

test('N01-a. fetch / WebSocket / net / tls / dns / dgram to external hosts are denied before the transport opens; a CAUGHT denial is still an evidence record with kind, host, port, pid and no URL secrets', async () => {
  const r = await isolated('deny', `
    import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';
    const out = {}; const done = (k, v) => { out[k] = v; };
    try { await fetch('https://api.kraken.com/0/public/Time?secret=SHOULD_NOT_APPEAR'); done('fetch', 'OPENED'); } catch (e) { done('fetch', e.cause?.code ?? e.code ?? e.message); }
    await new Promise((res) => { const ws = new WebSocket('wss://ws-auth.kraken.com/v2'); ws.onerror = (e) => done('wsError', e.error?.code ?? 'error'); ws.onclose = () => { done('wsClose', ws.readyState); res(); }; setTimeout(res, 500); });
    await new Promise((res) => { const s = net.connect(443, 'api.kraken.com'); s.on('error', (e) => { done('net', e.code); res(); }); s.on('connect', () => { done('net', 'OPENED'); res(); }); });
    await new Promise((res) => { const s = tls.connect({ host: 'example.com', port: 443 }); s.on('error', (e) => { done('tls', e.code); res(); }); s.on('secureConnect', () => { done('tls', 'OPENED'); res(); }); });
    await new Promise((res) => dns.resolve4('example.com', (e) => { done('dns', e?.code ?? 'RESOLVED'); res(); }));
    try { await dns.promises.lookup('example.org'); done('dnsp', 'RESOLVED'); } catch (e) { done('dnsp', e.code); }
    await new Promise((res) => { const u = dgram.createSocket('udp4'); u.send(Buffer.from('x'), 53, '8.8.8.8', (e) => { done('dgram', e?.code ?? 'SENT'); u.close(); res(); }); });
    console.log(JSON.stringify(out));`);
  assert.equal(r.failed, undefined, r.stderr); const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.fetch, 'OFFLINE_GUARD_DENIED'); assert.equal(out.wsError, 'OFFLINE_GUARD_DENIED'); assert.equal(out.wsClose, 3); assert.equal(out.net, 'OFFLINE_GUARD_DENIED'); assert.equal(out.tls, 'OFFLINE_GUARD_DENIED'); assert.equal(out.dns, 'OFFLINE_GUARD_DENIED'); assert.equal(out.dnsp, 'OFFLINE_GUARD_DENIED'); assert.equal(out.dgram, 'OFFLINE_GUARD_DENIED');
  assert.deepEqual(summary(r), ['FETCH api.kraken.com:443', 'WEBSOCKET ws-auth.kraken.com:443', 'SOCKET api.kraken.com:443', 'SOCKET example.com:443', 'DNS example.com:null', 'DNS example.org:null', 'DGRAM 8.8.8.8:53'], 'N01: exactly one evidence record per attempt, each caught by the application');
  for (const rec of r.records) { assert.equal(rec.pid > 0, true); assert.match(rec.run, /^selftest:deny:/); assert.ok(!JSON.stringify(rec).includes('SHOULD_NOT_APPEAR'), 'no URL / query material in the evidence'); assert.ok(Array.isArray(rec.stack)); }
});

test('N01-b. loopback HTTP and loopback sockets still work under the guard (no record), and a Node child spawned with a REPLACED env inherits the guard: its external attempt is recorded under its own pid while the promisified stdout contract holds', async () => {
  const r = await isolated('loopback', `
    import http from 'node:http'; import net from 'node:net'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
    const server = http.createServer((req, res) => res.end('local-ok')); await new Promise((res) => server.listen(0, '127.0.0.1', res)); const port = server.address().port;
    const body = await (await fetch('http://127.0.0.1:' + port + '/x')).text();
    const refused = await new Promise((res) => { const s = net.connect(1, '127.0.0.1'); s.on('error', (e) => res(e.code)); s.on('connect', () => res('OPENED')); });
    const child = await promisify(execFile)(process.execPath, ['-e', "fetch('https://example.net/').then(() => console.log('OPENED'), (e) => console.log(e.cause?.code ?? e.code))"], { env: { PATH: process.env.PATH } });
    server.close(); console.log(JSON.stringify({ body, refused, child: child.stdout.trim(), pid: process.pid }));`);
  assert.equal(r.failed, undefined, r.stderr); const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.body, 'local-ok', 'loopback HTTP works'); assert.equal(out.refused, 'ECONNREFUSED', 'a loopback socket reaches the real transport'); assert.equal(out.child, 'OFFLINE_GUARD_DENIED', 'N01: the child with a replaced env is guarded and its promisified stdout arrives');
  assert.deepEqual(summary(r), ['FETCH example.net:443']); assert.notEqual(r.records[0].pid, out.pid, 'recorded under the child pid');
});

test('N01-c. the gate checker: an empty log passes, a log with one non-selftest record fails, selftest records are excluded only by their run identity', async () => {
  const gate = path.resolve('tools/offline-gate.mjs'); const run = async (file) => { try { const o = await execFileP(process.execPath, [gate, file], { env: { PATH: process.env.PATH } }); return { code: 0, out: o.stdout }; } catch (e) { return { code: e.code, out: e.stdout }; } };
  const empty = path.join(TMP, 'empty.jsonl'); assert.equal((await run(empty)).code, 0);
  const bad = path.join(TMP, 'bad.jsonl'); writeFileSync(bad, `${JSON.stringify({ run: 'suite', kind: 'FETCH', host: 'api.kraken.com', port: 443, testFile: 'x.test.js' })}\n${JSON.stringify({ run: 'selftest:deny:1', kind: 'FETCH', host: 'example.com', port: 443 })}\n`); const b = await run(bad); assert.equal(b.code, 1); assert.equal(JSON.parse(b.out).unexpected, 1);
  const only = path.join(TMP, 'only.jsonl'); writeFileSync(only, `${JSON.stringify({ run: 'selftest:deny:1', kind: 'FETCH', host: 'example.com', port: 443 })}\n`); assert.equal((await run(only)).code, 0);
});

test('N02. the baseline network-leak witness and its closure: a LIVE Kraken adapter WITHOUT an injected WebSocket falls back to the process WebSocket and is denied at wss://ws-auth.kraken.com (exactly one WEBSOCKET record, the application still gets a handle); the scripted lifecycle double satisfies the same adapter with ZERO records; the once-leaking suites run guarded in isolation with ZERO records', async () => {
  // the witness: the pattern the reviewer caught (composeJudge callers that omit a WebSocket double) reproduced in isolation as an exact denial record
  const witness = await isolated('ws-witness', `
    import { createKrakenAdapter } from '${path.resolve('execution/kraken-adapter.js').replaceAll('\\', '/')}';
    const routes = { '/0/private/GetWebSocketsToken': { result: { token: 'SYNTHETIC-TOKEN', expires: 900 } } };
    const transport = async (url, init) => { const u = new URL(url); const r = routes[u.pathname]; return { status: r ? 200 : 404, ok: Boolean(r), text: async () => JSON.stringify(r ? { error: [], result: r.result } : {}) }; };
    let n = 0; const ad = createKrakenAdapter({ accountId: 'witness', clock: () => Date.now(), credentials: { key: 'k'.repeat(56), secret: Buffer.from('s'.repeat(64)).toString('base64') }, nonceStore: { next: async () => String(++n), peek: () => String(n) }, allowPrivate: () => true, allowOrders: () => false, transport, WebSocketImpl: globalThis.WebSocket });
    const h = await ad.connectExecutions(); await new Promise((r) => setTimeout(r, 50)); const st = ad.executionsState(); h.close();
    console.log(JSON.stringify({ ok: h.ok, connected: st.connected, gaps: st.gaps, closedByOwner: st.closedByOwner }));`);
  assert.equal(witness.failed, undefined, witness.stderr); const w = JSON.parse(witness.stdout.trim().split('\n').pop());
  assert.equal(w.ok, true, 'the adapter hands back a handle: the application does not see the denial as an exception'); assert.equal(w.connected, false); assert.equal(w.gaps, 1, 'the denied socket closes -> AFTER_GAP reconciliation');
  assert.deepEqual(summary(witness), ['WEBSOCKET ws-auth.kraken.com:443'], 'N02 witness: the attempt is denied before the transport opens and recorded exactly once');
  // the closure in-process: the scripted lifecycle double drives the SAME adapter through subscribe / ack / sequences / gap / venue drop / reconnect / owner close without any record
  const closure = await isolated('ws-scripted', `
    import { createKrakenAdapter } from '${path.resolve('execution/kraken-adapter.js').replaceAll('\\', '/')}';
    import { createScriptedWebSocket } from '${path.resolve('test/helpers/scripted-ws.js').replaceAll('\\', '/')}';
    let tokens = 0; const routes = { '/0/private/GetWebSocketsToken': () => ({ result: { token: 'SYNTHETIC-' + (++tokens), expires: 900 } }) };
    const transport = async (url, init) => { const u = new URL(url); const r = routes[u.pathname]; const out = typeof r === 'function' ? r() : r; return { status: out ? 200 : 404, ok: Boolean(out), text: async () => JSON.stringify(out ? { error: [], result: out.result } : {}) }; };
    const ws = createScriptedWebSocket(); let n = 0; const events = [];
    const ad = createKrakenAdapter({ accountId: 'scripted', clock: () => Date.now(), credentials: { key: 'k'.repeat(56), secret: Buffer.from('s'.repeat(64)).toString('base64') }, nonceStore: { next: async () => String(++n), peek: () => String(n) }, allowPrivate: () => true, allowOrders: () => false, transport, WebSocketImpl: ws.WebSocketImpl });
    ad.subscribe((e) => events.push(e.type + ':' + (e.payload?.scope ?? '')));
    const h = await ad.connectExecutions(); await new Promise((r) => setTimeout(r, 5));
    const s0 = ws.sockets[0]; const subscribeMsg = JSON.parse(s0.sent[0]); s0.executions([], { sequence: 1, type: 'snapshot' }); s0.executions([], { sequence: 2 }); s0.executions([], { sequence: 5 });
    const seqBefore = ad.executionsState().lastSeq; const pong = await ad.ping(); s0.drop('venue closed'); await new Promise((r) => setTimeout(r, 1100)); const s1 = ws.sockets[1]; await new Promise((r) => setTimeout(r, 5)); const st = ad.executionsState(); h.close(); await new Promise((r) => setTimeout(r, 20));
    console.log(JSON.stringify({ url: s0.url, subscribe: subscribeMsg.params, ackChannel: ws.log.filter((x) => x.event === 'MESSAGE').map((x) => x.channel), lastSeq: seqBefore, seqAfterReconnect: st.lastSeq, gaps: st.gaps, reconnects: st.reconnects, pong: pong.ok && pong.requestIdMatched, tokens, resubscribed: ws.subscribed(1), ownerClosed: s1.closedByOwner, sockets: ws.sockets.length, afterGap: events.filter((x) => x === 'RECONCILIATION:AFTER_GAP').length }));`);
  assert.equal(closure.failed, undefined, closure.stderr); const c = JSON.parse(closure.stdout.trim().split('\n').pop());
  assert.equal(c.url, 'wss://ws-auth.kraken.com/v2'); assert.deepEqual(c.subscribe, { channel: 'executions', token: 'SYNTHETIC-1', snap_orders: true, snap_trades: true }, 'the subscribe request carries the token'); assert.equal(c.ackChannel[0], 'subscribe', 'the venue acknowledgement is delivered'); assert.equal(c.lastSeq, 5); assert.equal(c.seqAfterReconnect, null, 'a reconnect resets the sequence: the next message cannot be judged contiguous'); assert.equal(c.gaps, 2, 'one sequence gap (2 -> 5) and one venue drop'); assert.equal(c.afterGap, 2); assert.equal(c.pong, true); assert.equal(c.reconnects, 1); assert.equal(c.tokens, 2, 'the reconnect fetched a fresh token'); assert.equal(c.resubscribed, true); assert.equal(c.ownerClosed, true); assert.equal(c.sockets, 2, 'no reconnect after the owner close');
  assert.deepEqual(summary(closure), [], 'N02: a scripted lifecycle reaches no network');
  // the closure at suite level: the once-leaking non-PG suites run guarded in a separate process with a selftest run identity and produce ZERO records (the PG suites are covered by the full guarded gate)
  for (const file of ['test/judge-repair-runtime.test.js', 'test/judge-repair-kraken.test.js']) {
    const log = path.join(TMP, `${path.basename(file)}.jsonl`); let out; try { out = await execFileP(process.execPath, ['--test', '--test-reporter=tap', file], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--import=${GUARD}`, COBRA_OFFLINE_GUARD_LOG: log, COBRA_OFFLINE_GUARD_RUN: `selftest:suite:${randomUUID().slice(0, 8)}` }, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }); } catch (err) { out = { stdout: err.stdout ?? '', stderr: err.stderr ?? '', failed: true }; }
    assert.equal(out.failed, undefined, `${file} failed under the guard: ${out.stderr.slice(-2000)}`); assert.match(out.stdout, /\n# fail 0\n/, file); assert.equal(existsSync(log) ? readFileSync(log, 'utf8').trim() : '', '', `${file}: zero denied attempts under the guard`);
  }
});
