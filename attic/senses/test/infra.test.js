// INFRA — the dark infrastructure-observation tier (owner scope I01-I03): registry law, pure parsers (NOAA Kp / scales, RIPEstat
// routing status, Cloudflare Radar BGP timeseries) that never turn a connected socket or a metadata envelope into a
// measurement, the composed collector under an injected transport (gates make ZERO calls; token only in a header; partial
// coverage; failure containment; restart), the reader and the profile / readiness wiring. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { INFRA_SOURCES, INFRA_SOURCE_IDS, infraRegistryError, infraSource } from '../infra/registry.js';
import { noaaKpObservations, noaaScalesObservation, ripeRoutingStatusObservation, cloudflareBgpTimeseriesObservation, infraObservationError, INFRA_OBSERVATION_KINDS, RIPE_RESOURCE_RE } from '../infra/parse.js';
import { startInfra, INFRA_STATES, ripeResourcesFromEnv } from '../infra/collector.js';
import { readInfraObservations, readInfraStatus, infraStatusFile } from '../infra/reader.js';
import { loadProfile, profileEnvironment } from '../paper/profile.js';
import { sensorSnapshot, snapshotRow } from '../paper/readiness.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const T0 = Date.parse('2026-09-12T04:30:00Z');
const timers = { setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} };
const KP = [{ time_tag: '2026-09-12T00:00:00', Kp: 2.33, a_running: 9, station_count: 8 }, { time_tag: '2026-09-12T03:00:00', Kp: 3, a_running: 15, station_count: 8 }, { time_tag: 'bad', Kp: 1, a_running: 1, station_count: 1 }, { time_tag: '2026-09-12T06:00:00', Kp: 12, a_running: 1, station_count: 1 }];
const SCALES = { '-1': { DateStamp: '2026-09-11', TimeStamp: '00:00:00', R: { Scale: '1' }, S: { Scale: '0' }, G: { Scale: '2' } }, '0': { DateStamp: '2026-09-12', TimeStamp: '04:01:00', R: { Scale: '0', Text: 'none' }, S: { Scale: '0', Text: 'none' }, G: { Scale: '1', Text: 'minor' } }, '1': { DateStamp: '2026-09-13', R: { Scale: '2' } } };
const RIPE = (resource) => ({ status: 'ok', data_call_status: 'supported', data: { resource, query_time: '2026-09-12T00:00:00', visibility: { v4: { ris_peers_seeing: 325, total_ris_peers: 326 }, v6: { ris_peers_seeing: 0, total_ris_peers: 0 } }, origins: [{ origin: 13335, route_objects: ['APNIC'] }], first_seen: { prefix: resource, origin: '19855', time: '2001-11-14T00:00:00' }, last_seen: { prefix: resource, origin: '13335', time: '2026-09-12T00:00:00' }, more_specifics: [], less_specifics: [] } });
const CF = { success: true, errors: [], result: { meta: { aggInterval: '1h', dateRange: [{ startTime: '2026-09-11T04:00:00Z', endTime: '2026-09-12T04:00:00Z' }], lastUpdated: '2026-09-12T03:00:00Z' }, serie_0: { timestamps: ['2026-09-12T01:00:00Z', '2026-09-12T02:00:00Z', '2026-09-12T03:00:00Z'], values: ['1200', '1350.5', 'x'] } } };

test('INFRA-1. registry law: three stable ids with closed kinds, https routes on the pinned host, dated docs, NOAA marked experimental, RIPE config-gated, Cloudflare credential-gated; mutations refused', () => {
  assert.equal(infraRegistryError(), null); assert.deepEqual([...INFRA_SOURCE_IDS], ['NOAA_SWPC', 'RIPE_RIS', 'CLOUDFLARE_RADAR']);
  assert.equal(infraSource('NOAA_SWPC').experimental, true); assert.equal(infraSource('RIPE_RIS').configEnv, 'INFRA_RIPE_RESOURCES'); assert.equal(infraSource('CLOUDFLARE_RADAR').credentialEnv, 'CLOUDFLARE_API_TOKEN');
  for (const s of INFRA_SOURCES) { assert.ok(s.docs.every((d) => d.accessedOn === '2026-09-12')); for (const u of [...(s.products ?? []).map((p) => p.url), s.route].filter(Boolean)) { assert.equal(new URL(u).protocol, 'https:'); assert.equal(new URL(u).hostname, s.host); } assert.ok(s.cadenceSec >= 300); }
  const mut = (fn) => { const list = INFRA_SOURCES.map((s) => ({ ...s })); fn(list); return infraRegistryError(list); };
  assert.ok(mut((l) => { l[1].route = 'http://stat.ripe.net/x'; })); assert.ok(mut((l) => { l[0].id = 'RIPE_RIS'; })); assert.ok(mut((l) => { l[2].kind = 'TRADING'; })); assert.ok(mut((l) => { l[1].cadenceSec = 10; }));
});

test('INFRA-2. pure parsers: a measurement exists only from a parsed payload — NOAA rows with a bad clock or an impossible Kp are rejected, forecast scale entries are excluded (current "0" only), RIPE status carries day-precision clocks and integer peer counts, Cloudflare numeric strings become numbers and invalid points are dropped, an error envelope yields no observation; every observation passes the closed shape and forged ids fail', () => {
  const kp = noaaKpObservations(KP, { receiptTs: T0 }); assert.equal(kp.observations.length, 2); assert.equal(kp.rejected.length, 2); for (const o of kp.observations) { assert.equal(infraObservationError(o), null); assert.equal(o.kind, 'NOAA_KP'); assert.equal(o.experimental, true); assert.equal(o.authority, 'NONE'); }
  const sc = noaaScalesObservation(SCALES, { receiptTs: T0 }); assert.ok(sc.observation); assert.equal(sc.excludedForecasts, 2); assert.equal(infraObservationError(sc.observation), null); assert.equal(sc.observation.values.G, 1);
  assert.ok(!noaaScalesObservation({ '1': SCALES['1'] }, { receiptTs: T0 }).observation, 'no current entry -> no observation');
  assert.ok(RIPE_RESOURCE_RE.test('1.1.1.0/24') && RIPE_RESOURCE_RE.test('AS13335') && !RIPE_RESOURCE_RE.test('garbage'));
  const rr = ripeRoutingStatusObservation(RIPE('1.1.1.0/24'), { resource: '1.1.1.0/24', receiptTs: T0 }); assert.ok(rr.observation); assert.equal(infraObservationError(rr.observation), null); assert.equal(rr.observation.sourceClockPrecision, 'DAY'); assert.equal(rr.observation.values.visibility.v4.seeing, 325);
  assert.ok(!ripeRoutingStatusObservation({ status: 'ok', data_call_status: 'supported' }, { resource: '1.1.1.0/24', receiptTs: T0 }).observation, 'a supported status without data is not a measurement');
  const cf = cloudflareBgpTimeseriesObservation(CF, { receiptTs: T0, scope: { asn: ['13335'], prefix: null, dateRange: '1d' } }); assert.ok(cf.observation); assert.equal(infraObservationError(cf.observation), null); assert.equal(cf.observation.values.points.length, 2); assert.equal(cf.observation.values.points[0].value, 1200); assert.equal(cf.invalidPoints, 1);
  const err = cloudflareBgpTimeseriesObservation({ success: false, errors: [{ code: 9106, message: 'auth' }], result: null }, { receiptTs: T0, scope: {} }); assert.ok(!err.observation); assert.equal(err.errorCode, 9106);
  for (const o of [kp.observations[0], sc.observation, rr.observation, cf.observation]) { assert.ok(INFRA_OBSERVATION_KINDS.includes(o.kind)); assert.ok(infraObservationError({ ...o, observationId: 'f'.repeat(64) })); assert.ok(infraObservationError({ ...o, authority: 'JUDGE' })); }
});

test('INFRA-3. composed collector under an injected transport: dark without INFRA_OBS_ENABLED; CREDENTIAL_REQUIRED / CONFIG_REQUIRED gates make ZERO calls; the token travels only in an authorization header (never a URL, never the status file); RIPE reports partial coverage when one configured resource fails; a token-refused answer parks Cloudflare as CREDENTIAL_REQUIRED; one failed source never touches another; restart keeps the seen set', async () => {
  const dir = tmp('infra-'); let t = T0; const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.authorization ?? null });
    if (url.includes('k-index')) return Response.json(KP); if (url.includes('scales')) return Response.json(SCALES);
    if (url.includes('stat.ripe.net')) { const res = decodeURIComponent(new URL(url).searchParams.get('resource')); return res === 'AS65000' ? new Response('nope', { status: 500 }) : Response.json(RIPE(res)); }
    if (url.includes('cloudflare')) return init.headers.authorization === 'Bearer tok-abc' ? Response.json(CF) : Response.json({ success: false, errors: [{ code: 9106, message: 'Missing X-Auth-Key, X-Auth-Email or Authorization headers' }], result: null }, { status: 400 });
    return new Response('?', { status: 404 }); };
  assert.equal(startInfra({ env: {}, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }), null); assert.equal(calls.length, 0);
  const gated = startInfra({ env: { INFRA_OBS_ENABLED: 'true', INFRA_SOURCES: 'NOAA_SWPC,RIPE_RIS,CLOUDFLARE_RADAR' }, dataDir: dir, fetchImpl, clock: () => (t += 1000), log: () => {}, timers, signals: false });
  assert.deepEqual(await gated.pollOnce('NOAA_SWPC'), { outcome: 'OBSERVED', admitted: 3, partial: false }); assert.equal(await gated.pollOnce('RIPE_RIS'), null); assert.equal(await gated.pollOnce('CLOUDFLARE_RADAR'), null);
  let st = readInfraStatus(dir); assert.equal(st.sources.RIPE_RIS.state, 'CONFIG_REQUIRED'); assert.equal(st.sources.CLOUDFLARE_RADAR.state, 'CREDENTIAL_REQUIRED'); assert.equal(st.sources.NOAA_SWPC.state, 'OBSERVED'); assert.equal(calls.filter((c) => !c.url.includes('noaa')).length, 0, 'gated sources: zero requests'); gated.stop();
  assert.deepEqual(ripeResourcesFromEnv({ INFRA_RIPE_RESOURCES: '1.1.1.0/24, AS65000, garbage' }), { valid: ['1.1.1.0/24', 'AS65000'], invalid: ['garbage'], truncated: false });
  const env = { INFRA_OBS_ENABLED: 'true', INFRA_SOURCES: 'NOAA_SWPC,RIPE_RIS,CLOUDFLARE_RADAR', INFRA_RIPE_RESOURCES: '1.1.1.0/24, AS65000, garbage', CLOUDFLARE_API_TOKEN: 'tok-abc', INFRA_CLOUDFLARE_ASN: '13335' };
  const h = startInfra({ env, dataDir: dir, fetchImpl, clock: () => (t += 1000), log: () => {}, timers, signals: false });
  assert.deepEqual(await h.pollOnce('NOAA_SWPC'), { outcome: 'OBSERVED', admitted: 0, partial: false }, 'restart: the seen set survives — nothing re-admitted'); assert.deepEqual(await h.pollOnce('RIPE_RIS'), { outcome: 'OBSERVED', admitted: 1, partial: true }); assert.deepEqual(await h.pollOnce('CLOUDFLARE_RADAR'), { outcome: 'OBSERVED', admitted: 1, partial: false });
  st = readInfraStatus(dir); assert.match(st.sources.RIPE_RIS.coverage, /1 of 2/); assert.equal(st.sources.CLOUDFLARE_RADAR.state, 'OBSERVED'); for (const s of Object.values(st.sources)) assert.ok(INFRA_STATES.includes(s.state));
  assert.ok(!JSON.stringify(st).includes('tok-abc'), 'the token never reaches the status file'); assert.ok(calls.every((c) => !c.url.includes('tok-abc'))); assert.equal(calls.filter((c) => c.auth === 'Bearer tok-abc').length, 1);
  const obs = readInfraObservations(dir, {}); assert.equal(obs.observations.length, 5); assert.equal(obs.corrupt, 0); assert.deepEqual([...new Set(obs.observations.map((o) => o.kind))].sort(), ['CF_RADAR_BGP_TIMESERIES', 'NOAA_KP', 'NOAA_SCALES', 'RIS_ROUTING_STATUS']);
  h.stop();
  const refused = startInfra({ env: { ...env, CLOUDFLARE_API_TOKEN: 'wrong' }, dataDir: dir, fetchImpl, clock: () => (t += 1000), log: () => {}, timers, signals: false }); assert.deepEqual(await refused.pollOnce('CLOUDFLARE_RADAR'), { outcome: 'CREDENTIAL_REQUIRED' }); st = readInfraStatus(dir); assert.equal(st.sources.CLOUDFLARE_RADAR.state, 'CREDENTIAL_REQUIRED'); assert.ok(st.sources.CLOUDFLARE_RADAR.backoffUntil > t); assert.deepEqual(await refused.pollOnce('NOAA_SWPC'), { outcome: 'OBSERVED', admitted: 0, partial: false }, 'containment: a refused Cloudflare leaves NOAA polling normally'); st = readInfraStatus(dir); assert.equal(st.sources.NOAA_SWPC.state, 'OBSERVED'); assert.equal(st.sources.CLOUDFLARE_RADAR.state, 'CREDENTIAL_REQUIRED'); refused.stop();
});

test('INFRA-4. reader + profile + snapshot: corrupt lines are counted not returned; the profile derives INFRA_OBS_ENABLED / INFRA_SOURCES (ON + REQUEST rows) and never a token; the snapshot shows CONFIG_REQUIRED / BLOCKED_CREDENTIAL from env NAMES, NOT_OBSERVED without a status record, ACTIVE only from a fresh success, and never a Bearer fragment', () => {
  const p = loadProfile(); const env = profileEnvironment(p); assert.equal(env.INFRA_OBS_ENABLED, 'true'); assert.equal(env.INFRA_SOURCES, 'NOAA_SWPC,RIPE_RIS,CLOUDFLARE_RADAR'); assert.ok(!('CLOUDFLARE_API_TOKEN' in env));
  const dir = tmp('infra-snap-'); mkdirSync(path.join(dir, 'infra'), { recursive: true }); const now = T0;
  const o = noaaKpObservations(KP, { receiptTs: now }).observations[0]; writeFileSync(path.join(dir, 'infra', 'observations.jsonl'), `${JSON.stringify(o)}\n{bad\n${JSON.stringify({ ...o, values: { Kp: 99 } })}\n`);
  const r = readInfraObservations(dir, { kind: 'NOAA_KP' }); assert.equal(r.observations.length, 1); assert.equal(r.corrupt, 2);
  const s0 = sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now }); assert.equal(snapshotRow(s0, 'INFRA_NOAA_SWPC').state, 'NOT_OBSERVED'); assert.equal(snapshotRow(s0, 'INFRA_RIPE_RIS').state, 'CONFIG_REQUIRED:INFRA_RIPE_RESOURCES'); assert.equal(snapshotRow(s0, 'INFRA_CLOUDFLARE_RADAR').state, 'BLOCKED_CREDENTIAL'); assert.match(snapshotRow(s0, 'INFRA_NOAA_SWPC').name, /EXPERIMENTAL/);
  const status = (state, lastSuccessTs) => ({ v: 'infra-status-1', tsMs: now, enabled: true, authority: 'NONE', sources: { NOAA_SWPC: { kind: 'SPACE_WEATHER', experimental: true, desired: 'ON', gate: 'IDLE', state, cadenceSec: 600, credentialEnv: null, configEnv: null, lastReceiptTs: now, lastSuccessTs, lastError: state === 'FAILED' ? 'HTTP 503' : null, backoffUntil: null, coverage: 'KP + SCALES(current)', counters: { admitted: 3, requests: 2 } } } });
  writeFileSync(infraStatusFile(dir), JSON.stringify(status('OBSERVED', now - 1000))); assert.equal(snapshotRow(sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now }), 'INFRA_NOAA_SWPC').state, 'ACTIVE');
  assert.equal(snapshotRow(sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now: now + 4 * 3_600_000 }), 'INFRA_NOAA_SWPC').state, 'ACTIVE_DEGRADED');
  writeFileSync(infraStatusFile(dir), JSON.stringify(status('FAILED', null))); assert.equal(snapshotRow(sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now }), 'INFRA_NOAA_SWPC').state, 'BLOCKED_PROVIDER');
  const withTok = sensorSnapshot({ profile: p, env: { ...env, CLOUDFLARE_API_TOKEN: 'tok-abc', INFRA_RIPE_RESOURCES: 'AS13335', INFRA_CLOUDFLARE_ASN: '13335' }, dataDir: dir, now }); assert.equal(snapshotRow(withTok, 'INFRA_CLOUDFLARE_RADAR').state, 'NOT_OBSERVED', 'a present credential is never green by itself'); assert.equal(snapshotRow(withTok, 'INFRA_RIPE_RIS').state, 'NOT_OBSERVED'); assert.ok(!JSON.stringify(withTok).includes('tok-abc'));
});

test('INFRA-5. composition + authority fences: fly.js starts the infra collector after the gateway and before the tape; infra/ imports no trading, control, research or RUMOR-2 module; no authority module imports infra/; nothing under infra/ names an order verb', () => {
  const fly = readFileSync(path.join(REPO, 'fly.js'), 'utf8'); assert.ok(fly.includes("import { startInfra } from './infra/collector.js';")); assert.ok(fly.indexOf('startGateway();') < fly.indexOf('startInfra();')); assert.ok(fly.indexOf('startInfra();') < fly.indexOf('await runTape('));
  const tracked = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.js'));
  const imports = (f) => [...readFileSync(path.join(REPO, f), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const f of tracked.filter((x) => x.startsWith('infra/'))) { for (const spec of imports(f)) assert.ok(!/judge\/|execution\/|watch\/|tape\/|ledger\/|cost\/|state\/|market-lab\/|socrates\/|research\/|rumor2\//.test(spec), `${f} -> ${spec}`); assert.ok(!/addOrder|placeOrder|cancelOrder|editOrder/.test(readFileSync(path.join(REPO, f), 'utf8')), `${f} names an order verb`); }
  for (const f of tracked.filter((x) => /^(judge|execution|watch|tape|ledger|cost|state|rumor2|market-lab|socrates)\//.test(x))) assert.ok(!imports(f).some((s) => s.includes('infra/')), `${f} imports infra/`);
});

test('Invalid routing scopes never expand Cloudflare collection to global',async()=>{
  let calls=0;const {validRoutingResource}=await import('../infra/parse.js');
  for(const value of ['999.1.1.0/24','1.1.1.0/33','2001:db8::/129','AS4294967296','abcd/64'])assert.equal(validRoutingResource(value),false);
  for(const extra of [{},{INFRA_CLOUDFLARE_PREFIX:'999.1.1.0/24'},{INFRA_CLOUDFLARE_ASN:'bad'},{INFRA_CLOUDFLARE_ASN:'13335',INFRA_CLOUDFLARE_DATE_RANGE:'bad'}]){
    const h=startInfra({env:{INFRA_OBS_ENABLED:'true',INFRA_SOURCES:'CLOUDFLARE_RADAR',CLOUDFLARE_API_TOKEN:'fixture',...extra},dataDir:tmp('infra-scope-'),fetchImpl:async()=>{calls++;},clock:()=>T0,timers,signals:false,log:()=>{}});
    assert.equal(h.status().sources.CLOUDFLARE_RADAR.state,'CONFIG_REQUIRED');assert.equal(await h.pollOnce('CLOUDFLARE_RADAR'),null);h.stop();
  }assert.equal(calls,0);
});
