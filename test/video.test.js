// VIDEO — the social-video observation tier (owner scope S10, YouTube): registry law, pure metadata mapping (never captions /
// transcripts), the closed gate (key -> own queries -> explicit budget; zero requests until every element holds), the composed
// collector under an injected transport (valid page -> observations + counters through the closed shape; quotaExceeded parks
// until the next accounting day; a refused key parks for an hour; 429 honoured; malformed refused), the budget counted in the
// durable checkpoint across restarts, key redaction, the reader, the profile / readiness wiring and the composition fences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { YOUTUBE_DATA_API, VIDEO_SOURCES, videoRegistryError } from '../video/registry.js';
import { searchItemsToObservations, videoStatisticsById, withStatistics, videoObservationError } from '../video/parse.js';
import { startVideo, videoConfigFromEnv, videoGate, pollIntervalMs, accountingDay, VIDEO_STATES } from '../video/collector.js';
import { readVideoObservations, readVideoStatus, videoStatusFile } from '../video/reader.js';
import { loadProfile, profileEnvironment, SECRET_ENV_NAMES } from '../paper/profile.js';
import { sensorSnapshot, snapshotRow } from '../paper/readiness.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const T0 = Date.parse('2026-09-12T18:00:00Z'); // 11:00 Pacific
const KEY = 'AIza-test-key-0123456789';
const timers = { setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} };
const item = (id, extra = {}) => ({ kind: 'youtube#searchResult', id: { kind: 'youtube#video', videoId: id }, snippet: { publishedAt: '2026-09-12T16:00:00Z', channelId: 'UCabcdefghijklmnopqrstuv', channelTitle: 'Chan', title: `Title ${id}`, description: 'desc', liveBroadcastContent: 'none', thumbnails: { default: { url: 'https://i.ytimg.com/x.jpg' } }, ...extra } });
const page = (ids) => ({ kind: 'youtube#searchListResponse', pageInfo: { totalResults: ids.length }, items: ids.map((id) => item(id)) });
const stats = (ids) => ({ kind: 'youtube#videoListResponse', items: ids.map((id) => ({ kind: 'youtube#video', id, statistics: { viewCount: '1200', likeCount: '34', commentCount: '5' } })) });
const BASE = { SOCIAL_VIDEO_ENABLED: 'true', YOUTUBE_API_KEY: KEY, SOCIAL_VIDEO_YOUTUBE_QUERIES: 'bitcoin, ethereum', SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES: '4' };

test('VIDEO-1. registry law + closed gate: one stable source with dated docs, https endpoints on the pinned host, METADATA_ONLY; the gate refuses in order DISABLED -> CREDENTIAL_MISSING -> CONFIG_REQUIRED -> BUDGET_NOT_CONFIGURED -> BUDGET_INVALID and never reads a default budget; the interval never drops below the documented floor', () => {
  assert.equal(videoRegistryError(), null); assert.equal(VIDEO_SOURCES.length, 1); assert.equal(YOUTUBE_DATA_API.coverage, 'METADATA_ONLY'); assert.ok(YOUTUBE_DATA_API.docs.every((d) => d.accessedOn === '2026-09-12')); for (const u of Object.values(YOUTUBE_DATA_API.endpoints)) assert.equal(new URL(u).hostname, YOUTUBE_DATA_API.host);
  assert.ok(videoRegistryError([{ ...YOUTUBE_DATA_API, endpoints: { search: 'https://evil.example/v3/search' } }])); assert.ok(videoRegistryError([{ ...YOUTUBE_DATA_API, coverage: 'TRANSCRIPTS' }]));
  const g = (env) => videoGate(videoConfigFromEnv(env)).reason;
  assert.equal(g({}), 'DISABLED'); assert.equal(g({ SOCIAL_VIDEO_ENABLED: 'true' }), 'CREDENTIAL_MISSING'); assert.equal(g({ SOCIAL_VIDEO_ENABLED: 'true', YOUTUBE_API_KEY: KEY }), 'CONFIG_REQUIRED'); assert.equal(g({ SOCIAL_VIDEO_ENABLED: 'true', YOUTUBE_API_KEY: KEY, SOCIAL_VIDEO_YOUTUBE_QUERIES: 'a' }), 'BUDGET_NOT_CONFIGURED'); assert.equal(g({ ...BASE, SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES: '0' }), 'BUDGET_INVALID'); assert.equal(g({ ...BASE, SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES: 'lots' }), 'BUDGET_INVALID'); assert.equal(g({ ...BASE, SOCIAL_VIDEO_YOUTUBE_QUERIES: 'a,b,c,d,e,f,g,h,i' }), 'CONFIG_REQUIRED'); assert.equal(g(BASE), null);
  assert.equal(pollIntervalMs(videoConfigFromEnv(BASE)), 21_600_000, '4 searches / day -> one every 6 h'); assert.equal(pollIntervalMs(videoConfigFromEnv({ ...BASE, SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES: '5000' })), 900_000, 'floor 15 min');
  assert.equal(accountingDay(T0), '2026-09-12'); assert.equal(accountingDay(Date.parse('2026-09-13T06:59:00Z')), '2026-09-12', 'Pacific accounting day'); assert.equal(accountingDay(Date.parse('2026-09-13T07:01:00Z')), '2026-09-13');
});

test('VIDEO-2. pure mapping: metadata only (title / description snippet / channel / publish clock), bounded, identity from the video id, future-dated / malformed items rejected, error envelopes yield no observation with the provider reason, statistics parsed from strings; the closed shape refuses caption / transcript fields, a forged id and non-NONE authority', () => {
  const r = searchItemsToObservations(page(['vid00001', 'vid00002']), { query: 'bitcoin', receiptTs: T0 }); assert.equal(r.observations.length, 2); assert.equal(r.rejected, 0); const o = r.observations[0];
  assert.equal(videoObservationError(o), null); assert.equal(o.kind, 'VIDEO_METADATA'); assert.equal(o.transcript, false); assert.equal(o.coverage, 'METADATA_ONLY'); assert.equal(o.authority, 'NONE'); assert.equal(o.knownAtTs, T0); assert.equal(o.publishedTs, Date.parse('2026-09-12T16:00:00Z')); assert.ok(!('thumbnails' in o));
  const bad = searchItemsToObservations({ items: [item('x'), { id: { videoId: 'vid00003' }, snippet: { publishedAt: 'nope', channelId: 'UCabcdefghijklmnopqrstuv', title: 't' } }, item('vid00004', { publishedAt: '2026-09-12T19:00:00Z' }), item('vid00005', { title: '' })] }, { query: 'q', receiptTs: T0 }); assert.equal(bad.observations.length, 0); assert.equal(bad.rejected, 4, 'short id, bad clock, future-dated, empty title');
  const env = searchItemsToObservations({ error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, { query: 'q', receiptTs: T0 }); assert.equal(env.observations.length, 0); assert.equal(env.errorCode, 403); assert.equal(env.errorReason, 'quotaExceeded');
  assert.equal(searchItemsToObservations('x', { query: 'q', receiptTs: T0 }).reason, 'not an object');
  const m = videoStatisticsById(stats(['vid00001'])); assert.deepEqual(m.get('vid00001'), { viewCount: 1200, likeCount: 34, commentCount: 5 }); const e = withStatistics(o, m.get('vid00001')); assert.equal(videoObservationError(e), null); assert.equal(e.statistics.viewCount, 1200); assert.equal(withStatistics(o, null).statistics, null);
  assert.ok(videoObservationError({ ...o, captions: 'text' })); assert.ok(videoObservationError({ ...o, transcript: 'full text' })); assert.ok(videoObservationError({ ...o, observationId: 'f'.repeat(64) })); assert.ok(videoObservationError({ ...o, authority: 'NOMINATE' })); assert.ok(videoObservationError({ ...o, statistics: { viewCount: -1, likeCount: null, commentCount: null } }));
});

test('VIDEO-3. composed collector under an injected transport: dark without the enable (null, zero calls); a gated start writes the gate state and makes ZERO requests; a valid page appends observations with counters through the closed shape; the key travels only in the header and is redacted from every error; the budget is spent before the request leaves and counted per accounting day in the checkpoint across a restart; BUDGET_STOPPED at the cap; quotaExceeded parks until the next day; a refused key parks for an hour; 429 honoured; malformed body refused; one failed poll never corrupts the file', async () => {
  const dir = tmp('video-'); let t = T0; const calls = []; let mode = 'ok';
  const fetchImpl = async (url, init) => { calls.push({ url, key: init.headers['x-goog-api-key'] ?? null });
    if (url.includes('/videos?')) return Response.json(stats(new URL(url).searchParams.get('id').split(',')));
    if (mode === 'quota') return Response.json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
    if (mode === 'badkey') return Response.json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } }, { status: 400 });
    if (mode === '429') return new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    if (mode === 'html') return new Response('<html>oops</html>', { status: 200 });
    if (mode === 'throw') throw new Error(`socket reset while sending ${KEY}`);
    const q = new URL(url).searchParams.get('q'); return Response.json(page(q === 'bitcoin' ? ['vid00001', 'vid00002'] : ['vid00003'])); };
  assert.equal(startVideo({ env: {}, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }), null); assert.equal(calls.length, 0);
  const gated = startVideo({ env: { SOCIAL_VIDEO_ENABLED: 'true' }, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }); assert.equal(await gated.pollOnce(), null); assert.equal(readVideoStatus(dir).state, 'CREDENTIAL_MISSING'); assert.equal(calls.length, 0); gated.stop();
  const h = startVideo({ env: BASE, dataDir: dir, fetchImpl, clock: () => (t += 1000), log: () => {}, timers, signals: false }); assert.equal(h.intervalMs, 21_600_000);
  assert.deepEqual(await h.pollOnce(), { outcome: 'OBSERVED', admitted: 2 }); assert.deepEqual(await h.pollOnce(), { outcome: 'OBSERVED', admitted: 1 }, 'queries rotate');
  let st = readVideoStatus(dir); assert.equal(st.state, 'OBSERVED'); assert.equal(st.quota.searchCalls, 2); assert.equal(st.quota.maxDailySearches, 4); assert.equal(st.counters.videosLists, 2); assert.equal(st.authority, 'NONE'); assert.ok(!JSON.stringify(st).includes(KEY), 'no key in the status file');
  assert.ok(calls.every((c) => !c.url.includes(KEY)), 'the key never enters a URL'); assert.ok(calls.every((c) => c.key === KEY), 'every request carries the header'); assert.ok(calls[0].url.includes('order=date') && calls[0].url.includes('type=video') && calls[0].url.includes('maxResults=25'));
  const obs = readVideoObservations(dir, {}); assert.equal(obs.observations.length, 3); assert.equal(obs.corrupt, 0); assert.ok(obs.observations.every((o) => videoObservationError(o) === null && o.statistics.viewCount === 1200));
  assert.deepEqual(await h.pollOnce(), { outcome: 'EMPTY', admitted: 0 }, 'same page again: duplicates are not re-admitted'); assert.ok(calls.filter((c) => c.url.includes('/search?')).pop().url.includes('publishedAfter='), 'the cursor narrows the next search');
  mode = 'throw'; assert.deepEqual(await h.pollOnce(), { outcome: 'FAILED', admitted: 0 }); st = readVideoStatus(dir); assert.equal(st.state, 'FAILED'); assert.equal(st.lastError, 'transport failed', 'arbitrary transport error text is never persisted'); assert.ok(!st.lastError.includes(KEY));
  assert.equal(await h.pollOnce(), null, 'in backoff'); t += 61_000; mode = 'ok'; assert.deepEqual(await h.pollOnce(), { outcome: 'BUDGET_STOPPED', admitted: 0 }, '4 searches spent (the failed one counted): the budget is law'); st = readVideoStatus(dir); assert.equal(st.state, 'BUDGET_STOPPED'); assert.equal(st.quota.searchCalls, 4); assert.equal(calls.filter((c) => c.url.includes('/search?')).length, 4);
  h.stop();
  const h2 = startVideo({ env: BASE, dataDir: dir, fetchImpl, clock: () => (t += 1000), log: () => {}, timers, signals: false }); assert.equal(readVideoStatus(dir).quota.searchCalls, 4, 'restart: the day\'s spend is restored from the checkpoint'); const searchesBefore = calls.filter((c) => c.url.includes('/search?')).length; assert.deepEqual(await h2.pollOnce(), { outcome: 'BUDGET_STOPPED', admitted: 0 }, 'still parked until the next accounting day'); assert.equal(calls.filter((c) => c.url.includes('/search?')).length, searchesBefore, 'zero requests while parked');
  t = Date.parse('2026-09-13T07:05:00Z'); assert.deepEqual(await h2.pollOnce(), { outcome: 'EMPTY', admitted: 0 }, 'a new Pacific day resets the counter'); assert.equal(readVideoStatus(dir).quota.searchCalls, 1); assert.equal(readVideoStatus(dir).quota.accountingDay, '2026-09-13');
  mode = 'quota'; assert.deepEqual(await h2.pollOnce(), { outcome: 'QUOTA_EXCEEDED', admitted: 0 }); st = readVideoStatus(dir); assert.equal(st.state, 'QUOTA_EXCEEDED'); assert.ok(st.backoffUntil >= Date.parse('2026-09-14T07:00:00Z'), 'parked until the next accounting day');
  t = Date.parse('2026-09-14T07:05:00Z'); mode = 'badkey'; assert.deepEqual(await h2.pollOnce(), { outcome: 'CREDENTIAL_REFUSED', admitted: 0 }); st = readVideoStatus(dir); assert.equal(st.state, 'CREDENTIAL_REFUSED'); assert.equal(st.backoffUntil - st.lastReceiptTs, 3_600_000);
  t += 3_600_001; mode = '429'; assert.deepEqual(await h2.pollOnce(), { outcome: 'RATE_LIMITED', admitted: 0 }); st = readVideoStatus(dir); assert.equal(st.backoffUntil - st.lastReceiptTs, 60_000, 'Retry-After 30 s floored at 60 s');
  t += 61_000; mode = 'html'; assert.deepEqual(await h2.pollOnce(), { outcome: 'PARSE_FAILED', admitted: 0 }); for (const s of [readVideoStatus(dir).state]) assert.ok(VIDEO_STATES.includes(s));
  assert.equal(readVideoObservations(dir, {}).corrupt, 0, 'no failed poll wrote a partial record'); assert.equal(startVideo({ env: BASE, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }), h2, 'no duplicate loops'); h2.stop();
});

test('VIDEO-4. reader + profile + snapshot: corrupt lines counted not returned; the profile REQUESTS the tier (SOCIAL_VIDEO_ENABLED) and names the key as a secret it never derives; the snapshot reads the gate from env NAMES (BLOCKED_CREDENTIAL -> CONFIG_REQUIRED -> BLOCKED_BUDGET), NOT_OBSERVED without a status record, ACTIVE only from a fresh success, BLOCKED_BUDGET from a parked collector, and never a key fragment', () => {
  const p = loadProfile(); const env = profileEnvironment(p); assert.equal(env.SOCIAL_VIDEO_ENABLED, 'true'); assert.ok(SECRET_ENV_NAMES.includes('YOUTUBE_API_KEY')); assert.ok(!('YOUTUBE_API_KEY' in env)); assert.equal(p.groups.social.YOUTUBE_DATA_API.desiredState, 'REQUEST');
  const dir = tmp('video-snap-'); mkdirSync(path.join(dir, 'video'), { recursive: true }); const now = T0;
  const o = searchItemsToObservations(page(['vid00001']), { query: 'q', receiptTs: now }).observations[0]; writeFileSync(path.join(dir, 'video', 'observations.jsonl'), `${JSON.stringify(o)}\n{bad\n${JSON.stringify({ ...o, transcript: 'x' })}\n`);
  const r = readVideoObservations(dir, { query: 'q' }); assert.equal(r.observations.length, 1); assert.equal(r.corrupt, 2);
  const row = (e, n = now) => snapshotRow(sensorSnapshot({ profile: p, env: { ...env, ...e }, dataDir: dir, now: n }), 'YOUTUBE_DATA_API');
  assert.equal(row({}).state, 'BLOCKED_CREDENTIAL'); assert.equal(row({ YOUTUBE_API_KEY: KEY }).state, 'CONFIG_REQUIRED:SOCIAL_VIDEO_YOUTUBE_QUERIES'); assert.equal(row({ YOUTUBE_API_KEY: KEY, SOCIAL_VIDEO_YOUTUBE_QUERIES: 'a' }).state, 'BLOCKED_BUDGET'); const full = { YOUTUBE_API_KEY: KEY, SOCIAL_VIDEO_YOUTUBE_QUERIES: 'a', SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES: '10' }; assert.equal(row(full).state, 'NOT_OBSERVED', 'a present key is never green by itself'); assert.equal(row({ SOCIAL_VIDEO_ENABLED: 'false' }).state, 'DISABLED_BY_PAPER_POLICY');
  const status = (state, lastSuccessTs, extra = {}) => ({ v: 'video-status-1', tsMs: now, enabled: true, authority: 'NONE', provider: 'YOUTUBE_DATA_API', kind: 'SOCIAL_VIDEO', coverage: 'METADATA_ONLY', state, gate: 'OPEN', gateDetail: null, queries: ['a'], quota: { accountingDay: '2026-09-12', searchCalls: 3, maxDailySearches: 10, unitsOther: 3, intervalMs: 8_640_000 }, lastReceiptTs: now, lastSuccessTs, lastError: null, backoffUntil: null, counters: { admitted: 1 }, ...extra });
  writeFileSync(videoStatusFile(dir), JSON.stringify(status('OBSERVED', now - 1000))); assert.equal(row(full).state, 'ACTIVE'); assert.match(row(full).coverage, /searches 3 \/ 10/); assert.equal(row(full, now + 4 * 3_600_000).state, 'ACTIVE_DEGRADED');
  writeFileSync(videoStatusFile(dir), JSON.stringify(status('BUDGET_STOPPED', now - 1000, { lastError: 'daily search budget 10 reached' }))); assert.equal(row(full).state, 'BLOCKED_BUDGET'); assert.match(row(full).blocker, /budget/);
  writeFileSync(videoStatusFile(dir), JSON.stringify(status('CREDENTIAL_REFUSED', null, { lastError: 'provider error 400: API key not valid' }))); assert.equal(row(full).state, 'BLOCKED_CREDENTIAL');
  assert.ok(!JSON.stringify(sensorSnapshot({ profile: p, env: { ...env, ...full }, dataDir: dir, now })).includes(KEY));
});

test('VIDEO-5. composition + authority fences: fly.js starts the video collector after the gateway and before the tape; video/ imports no trading, control, research or RUMOR-2 module (it is NOT a RUMOR-2 social provider — the sealed social registry is untouched); no authority module imports video/; the env example documents the names with placeholders only', () => {
  const fly = readFileSync(path.join(REPO, 'fly.js'), 'utf8'); assert.ok(fly.includes("import { startVideo } from './video/collector.js';")); assert.ok(fly.indexOf('startGateway();') < fly.indexOf('startVideo();')); assert.ok(fly.indexOf('startVideo();') < fly.indexOf('await runTape('));
  const tracked = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.js'));
  const imports = (f) => [...readFileSync(path.join(REPO, f), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const f of tracked.filter((x) => x.startsWith('video/'))) for (const spec of imports(f)) assert.ok(!/judge\/|execution\/|watch\/|tape\/|ledger\/|cost\/|state\/|market-lab\/|socrates\/|research\/|rumor2\//.test(spec), `${f} -> ${spec}`);
  for (const f of tracked.filter((x) => /^(judge|execution|watch|tape|ledger|cost|state|rumor2|market-lab|socrates)\//.test(x))) assert.ok(!imports(f).some((s) => s.includes('video/')), `${f} imports video/`);
  const sealedSocialRegistry = readFileSync(path.join(REPO, 'rumor2/social-registry.js'), 'utf8');
  assert.match(sealedSocialRegistry, /id:\s*'YOUTUBE_OFFICIAL'/, 'the pre-existing legacy YouTube boundary remains represented');
  assert.ok(!/id:\s*'YOUTUBE_DATA_API'/.test(sealedSocialRegistry), 'the video collector source was not added to the sealed social registry');
  const example = readFileSync(path.join(REPO, '.env.paper.example'), 'utf8'); for (const n of ['YOUTUBE_API_KEY', 'SOCIAL_VIDEO_YOUTUBE_QUERIES', 'SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES']) assert.ok(example.includes(n), n); assert.match(example, /YOUTUBE_API_KEY=<[^>]+>/);
});

test('VIDEO-6. opaque pages survive restart and a recovered append is never duplicated when its checkpoint lagged',async()=>{
  const dir=tmp('video-pages-'), env={...BASE,SOCIAL_VIDEO_YOUTUBE_QUERIES:'bitcoin'};let calls=[];
  const fetchImpl=async url=>{const u=new URL(url);if(u.pathname.endsWith('/videos'))return Response.json(stats(u.searchParams.get('id').split(',')));calls.push(u);return Response.json(u.searchParams.get('pageToken')?page(['vid00002']):{...page(['vid00001']),nextPageToken:'opaque-next'});};
  const options={env,dataDir:dir,fetchImpl,clock:()=>T0,timers,signals:false,log:()=>{}};
  let h=startVideo(options);await h.pollOnce();h.stop();const cpFile=path.join(dir,'video','checkpoint-YOUTUBE_DATA_API.json');const cp=JSON.parse(readFileSync(cpFile));
  assert.equal(cp.perQuery.bitcoin.pageToken,'opaque-next');assert.equal(cp.perQuery.bitcoin.lastPublishedTs,null);
  h=startVideo(options);await h.pollOnce();h.stop();assert.equal(calls[1].searchParams.get('pageToken'),'opaque-next');assert.equal(calls[1].searchParams.has('publishedAfter'),false);assert.equal(readVideoObservations(dir).observations.length,2);
  // Simulate observation append/fsync succeeding but the checkpoint rename never happening.
  writeFileSync(cpFile,JSON.stringify(cp));h=startVideo(options);await h.pollOnce();h.stop();assert.equal(readVideoObservations(dir).observations.length,2);assert.equal(JSON.parse(readFileSync(cpFile)).perQuery.bitcoin.pageToken,null);
  writeFileSync(cpFile,'{"v":"video-checkpoint-1","searchCalls":');assert.throws(()=>startVideo(options),/JSON|checkpoint|position/i);
});

test('VIDEO-7. a malformed page cannot advance a cursor, and stop during statistics fetch cannot commit late metadata',async()=>{
  const dir=tmp('video-stop-');let release;let phase='bad';
  const options={env:{...BASE,SOCIAL_VIDEO_YOUTUBE_QUERIES:'bitcoin'},dataDir:dir,clock:()=>T0,timers,signals:false,log:()=>{},fetchImpl:async url=>{
    if(url.includes('/videos?'))return new Promise(resolve=>{release=()=>resolve(Response.json(stats(['vid00001'])));});
    return Response.json(phase==='bad'?{...page(['vid00001']),nextPageToken:42}:page(['vid00001']));
  }};
  let h=startVideo(options);assert.equal((await h.pollOnce()).outcome,'PARSE_FAILED');h.stop();assert.equal(readVideoObservations(dir).observations.length,0);
  phase='ok';h=startVideo(options);const pending=h.pollOnce();while(!release)await new Promise(resolve=>setImmediate(resolve));h.stop();release();assert.equal(await pending,null);assert.equal(readVideoObservations(dir).observations.length,0);
});
