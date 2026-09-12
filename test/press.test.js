// PRESS — the publisher-observation tier (owner scope P01-P09): registry law, pure item mapping, the composed collector under an
// injected transport (valid feed -> observations through the closed shape, 304, 429 with Retry-After, malformed / empty feeds,
// licensed rows make zero calls, containment of one failed source, restart continuity), the reader, the profile / readiness
// wiring and the composition + authority fences. No network: every transport is injected; the offline guard would refuse otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PRESS_SOURCES, PRESS_SOURCE_IDS, pressRegistryError, pressSource, PRESS_ROUTES, PRESS_KINDS } from '../press/registry.js';
import { itemToObservation, extractItemSources, pressObservationError, PRESS_LIMITS } from '../press/parse.js';
import { startPress, PRESS_STATES, pressSelectedIds } from '../press/collector.js';
import { readPressObservations, readPressStatus, pressStatusFile } from '../press/reader.js';
import { loadProfile, profileEnvironment, PROFILE_GROUPS } from '../paper/profile.js';
import { sensorSnapshot, snapshotRow, SNAPSHOT_GROUPS } from '../paper/readiness.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const T0 = Date.parse('2026-09-12T04:00:00Z');
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items.map((i) => `<item><title>${i.t}</title><link>${i.l}</link><guid>${i.g}</guid><pubDate>${i.p ?? 'Fri, 12 Sep 2026 03:00:00 GMT'}</pubDate><description>${i.d ?? 'sum'}</description>${i.s ? `<source url="https://pub.example">${i.s}</source>` : ''}</item>`).join('')}</channel></rss>`;
const timers = { setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} };
const ON = 'COINDESK_NEWS,THEBLOCK_NEWS,COINTELEGRAPH_NEWS,DECRYPT_NEWS';

test('PRESS-1. registry law: nine stable ids, closed kind / route vocabularies, https feed on the pinned host, cadence floor, dated docs, licensed rows carry no URL and a prerequisite; every mutation is refused', () => {
  assert.equal(pressRegistryError(), null); assert.deepEqual([...PRESS_SOURCE_IDS], ['REUTERS_NEWS', 'BLOOMBERG_NEWS', 'CNBC_NEWS', 'FT_NEWS', 'COINDESK_NEWS', 'THEBLOCK_NEWS', 'COINTELEGRAPH_NEWS', 'DECRYPT_NEWS', 'GOOGLE_NEWS_AGGREGATOR']);
  for (const s of PRESS_SOURCES) { assert.ok(PRESS_KINDS.includes(s.kind)); assert.ok(PRESS_ROUTES.includes(s.route)); assert.ok(s.docs.every((d) => d.accessedOn === '2026-09-12' && /^https:\/\//.test(d.url))); if (s.route === 'RSS') { assert.ok(s.feedUrl.startsWith('https://')); assert.equal(new URL(s.feedUrl).hostname, s.host); assert.ok(s.cadenceSec >= 300); } else { assert.equal(s.feedUrl, null); assert.match(s.prerequisite, /licensed/i); } }
  assert.equal(pressSource('GOOGLE_NEWS_AGGREGATOR').kind, 'AGGREGATOR'); assert.equal(pressSource('NOPE'), null);
  const mut = (fn) => { const list = PRESS_SOURCES.map((s) => ({ ...s, docs: [...s.docs] })); fn(list); return pressRegistryError(list); };
  assert.match(mut((l) => { l[4].feedUrl = 'http://www.coindesk.com/x'; }), /https/); assert.match(mut((l) => { l[4].feedUrl = 'https://evil.example/rss'; }), /host/); assert.match(mut((l) => { l[4].cadenceSec = 30; }), /cadence/); assert.match(mut((l) => { l[0].feedUrl = 'https://www.reuters.com/x'; }), /licensed/i); assert.match(mut((l) => { l[1].id = 'COINDESK_NEWS'; }), /duplicate/); assert.match(mut((l) => { l[4].kind = 'PRIMARY'; }), /vocabulary|kind/);
});

test('PRESS-2. pure mapping: headline / link / publisher clock only, bounded, identity from the source + guid (or link), future-dated items skipped, aggregator items keep the per-item publisher with the aggregator as transport; the closed shape refuses body fields and forged ids', () => {
  const src = pressSource('COINDESK_NEWS'); const base = { source: src, receiptTs: T0, feedKind: 'RSS', itemSources: null };
  const m = itemToObservation({ title: ' A '.padEnd(400, 'x'), summary: 'y'.repeat(900), link: 'https://www.coindesk.com/a?b=1', guid: 'g1', publishedTs: T0 - 60_000 }, base); assert.ok(m.observation); const o = m.observation;
  assert.equal(pressObservationError(o), null); assert.equal(o.title.length, PRESS_LIMITS.maxTitleChars); assert.equal(o.summary.length, PRESS_LIMITS.maxSummaryChars); assert.equal(o.linkHost, 'www.coindesk.com'); assert.equal(o.transport, 'DIRECT_FEED'); assert.equal(o.publisher, 'CoinDesk'); assert.equal(o.bodyFetched, false); assert.equal(o.authority, 'NONE'); assert.equal(o.knownAtTs, T0); assert.equal(o.coverage, 'HEADLINE_LINK_ONLY');
  assert.ok(itemToObservation({ title: 'future', link: 'https://www.coindesk.com/f', guid: 'f', publishedTs: T0 + 10 * 60_000 }, base).skip, 'future-dated skipped'); assert.ok(itemToObservation({ title: '', link: 'https://www.coindesk.com/e', guid: 'e', publishedTs: null }, base).skip, 'no title skipped');
  const same = itemToObservation({ title: 'A', link: 'https://www.coindesk.com/a', guid: 'g1', publishedTs: null }, base).observation; assert.equal(same.observationId, o.observationId, 'identity from source + guid, not the changing title'); assert.equal(same.publishedTs, null, 'absent clocks stay null (never invented)');
  const text = rss([{ t: 'Agg', l: 'https://a.example/1', g: 'a1', s: 'Alpha Wire' }]); const srcs = extractItemSources(text); assert.equal(srcs.get('https://a.example/1').name, 'Alpha Wire');
  const agg = itemToObservation({ title: 'Agg', link: 'https://a.example/1', guid: 'a1', publishedTs: null }, { source: pressSource('GOOGLE_NEWS_AGGREGATOR'), receiptTs: T0, feedKind: 'RSS', itemSources: srcs }).observation; assert.equal(agg.transport, 'GOOGLE_NEWS_AGGREGATOR'); assert.equal(agg.publisher, 'Alpha Wire'); assert.equal(agg.publisherResolved, true);
  assert.match(pressObservationError({ ...o, body: 'full article' }), /keys|body/i); assert.match(pressObservationError({ ...o, observationId: 'f'.repeat(64) }), /identity|observationId/i); assert.match(pressObservationError({ ...o, bodyFetched: true }), /law|body/i); assert.match(pressObservationError({ ...o, authority: 'NOMINATE' }), /law|authority/i);
});

test('PRESS-3. composed collector under an injected transport: dark without PRESS_ENABLED (null, zero calls); only PRESS_SOURCES rows poll; a valid feed appends observations through the closed shape then the checkpoint; 304 / 429 (Retry-After floored) / HTML / empty feeds are distinct states; a licensed row makes ZERO calls; one failed source never touches another; restart resumes with the etag and seen ids; a second start returns the same handle', async () => {
  const dir = tmp('press-'); let t = T0; const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ifNone: init.headers['if-none-match'] ?? null, ua: init.headers['user-agent'] });
    if (init.headers['if-none-match'] === '"c1"') return new Response(null, { status: 304 });
    if (url.includes('theblock')) return new Response('<html>login wall</html>', { status: 200 });
    if (url.includes('decrypt')) return new Response(null, { status: 429, headers: { 'retry-after': '5' } });
    if (url.includes('cointelegraph')) return new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>', { status: 200 });
    if (url.includes('coindesk')) return new Response(rss([{ t: 'One', l: 'https://www.coindesk.com/1', g: 'c1' }, { t: 'Two', l: 'https://www.coindesk.com/2', g: 'c2' }, { t: '', l: 'https://www.coindesk.com/3', g: 'c3' }]), { status: 200, headers: { etag: '"c1"' } });
    return new Response('nope', { status: 500 }); };
  assert.equal(startPress({ env: {}, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }), null); assert.equal(calls.length, 0);
  const env = { PRESS_ENABLED: 'true', PRESS_SOURCES: `${ON},REUTERS_NEWS` }; assert.deepEqual(pressSelectedIds(env), [...ON.split(','), 'REUTERS_NEWS']);
  const h = startPress({ env, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }); assert.ok(h);
  assert.deepEqual(await h.pollOnce('COINDESK_NEWS'), { outcome: 'OBSERVED', admitted: 2 }); assert.deepEqual(await h.pollOnce('THEBLOCK_NEWS'), { outcome: 'PARSE_FAILED', admitted: 0 }); assert.deepEqual(await h.pollOnce('DECRYPT_NEWS'), { outcome: 'RATE_LIMITED', admitted: 0 }); assert.deepEqual(await h.pollOnce('COINTELEGRAPH_NEWS'), { outcome: 'EMPTY_FEED', admitted: 0 }); assert.equal(await h.pollOnce('REUTERS_NEWS'), null); assert.equal(await h.pollOnce('FT_NEWS'), null, 'not selected: never polled');
  const st = readPressStatus(dir); assert.equal(st.v, 'press-status-1'); assert.equal(st.sources.COINDESK_NEWS.state, 'OBSERVED'); assert.equal(st.sources.THEBLOCK_NEWS.state, 'PARSE_FAILED'); assert.equal(st.sources.DECRYPT_NEWS.state, 'RATE_LIMITED'); assert.equal(st.sources.DECRYPT_NEWS.backoffUntil, t + 60_000, 'Retry-After 5 s floored at 60 s'); assert.equal(st.sources.COINTELEGRAPH_NEWS.state, 'EMPTY_FEED'); assert.equal(st.sources.REUTERS_NEWS.state, 'LICENSED_INTERFACE_REQUIRED'); assert.equal(st.sources.FT_NEWS.state, 'DISABLED'); assert.equal(st.authority, 'NONE');
  for (const s of Object.values(st.sources)) assert.ok(PRESS_STATES.includes(s.state), s.state);
  assert.equal(calls.filter((c) => c.url.includes('reuters') || c.url.includes('bloomberg') || c.url.includes('ft.com')).length, 0, 'licensed / unselected rows: zero requests'); assert.ok(calls.every((c) => /^SerpentCobra\/press/.test(c.ua)));
  const obs = readPressObservations(dir, {}); assert.equal(obs.observations.length, 2); assert.equal(obs.corrupt, 0); assert.ok(obs.observations.every((o) => pressObservationError(o) === null && o.sourceId === 'COINDESK_NEWS'));
  assert.equal(await h.pollOnce('DECRYPT_NEWS'), null, 'in backoff: no request'); t += 61_000; assert.deepEqual(await h.pollOnce('DECRYPT_NEWS'), { outcome: 'RATE_LIMITED', admitted: 0 });
  assert.deepEqual(await h.pollOnce('COINDESK_NEWS'), { outcome: 'NOT_MODIFIED', admitted: 0 }); assert.equal(calls.filter((c) => c.url.includes('coindesk')).pop().ifNone, '"c1"');
  assert.equal(startPress({ env, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }), h, 'no duplicate loops'); h.stop();
  const before = calls.length; const h2 = startPress({ env, dataDir: dir, fetchImpl, clock: () => t, log: () => {}, timers, signals: false }); assert.notEqual(h2, h); assert.deepEqual(await h2.pollOnce('COINDESK_NEWS'), { outcome: 'NOT_MODIFIED', admitted: 0 }); assert.equal(calls[before].ifNone, '"c1"', 'restart resumes the conditional GET from the checkpoint'); h2.stop();
  assert.equal(readPressObservations(dir, {}).observations.length, 2, 'seen ids survive the restart: nothing re-admitted');
});

test('PRESS-4. reader + snapshot: corrupt / forged lines are counted and never returned; the sensor snapshot colours a publisher ACTIVE only from a FRESH status record, DISABLED for OFF profile rows, BLOCKED_EXTERNAL_APPROVAL for licensed rows, BLOCKED_PROVIDER after a stale failure; the profile derives PRESS_ENABLED / PRESS_SOURCES from the ON rows only', () => {
  const p = loadProfile(); assert.ok(PROFILE_GROUPS.includes('publisherNews')); const env = profileEnvironment(p); assert.equal(env.PRESS_ENABLED, 'true'); assert.deepEqual(env.PRESS_SOURCES.split(','), ON.split(',')); assert.ok(!env.PRESS_SOURCES.includes('REUTERS'), 'licensed rows are never selected');
  const dir = tmp('press-snap-'); mkdirSync(path.join(dir, 'press'), { recursive: true }); const now = T0;
  const good = itemToObservation({ title: 'x', link: 'https://www.coindesk.com/x', guid: 'x', publishedTs: null }, { source: pressSource('COINDESK_NEWS'), receiptTs: now, feedKind: 'RSS' }).observation;
  writeFileSync(path.join(dir, 'press', 'observations.jsonl'), `${JSON.stringify(good)}\nnot json\n${JSON.stringify({ ...good, observationId: 'f'.repeat(64) })}\n`);
  const r = readPressObservations(dir, {}); assert.equal(r.observations.length, 1); assert.equal(r.corrupt, 2);
  const s0 = sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now }); assert.ok(SNAPSHOT_GROUPS.includes('PUBLISHER_NEWS')); assert.equal(s0.groups.PUBLISHER_NEWS.length, 9);
  assert.equal(snapshotRow(s0, 'PRESS_COINDESK_NEWS').state, 'NOT_OBSERVED'); assert.equal(snapshotRow(s0, 'PRESS_REUTERS_NEWS').state, 'BLOCKED_EXTERNAL_APPROVAL'); assert.equal(snapshotRow(s0, 'PRESS_FT_NEWS').state, 'DISABLED_BY_PAPER_POLICY'); assert.equal(snapshotRow(s0, 'PRESS_FT_NEWS').blocker, 'BLOCKED_TERMS'); assert.ok(s0.rows.filter((x) => x.group === 'PUBLISHER_NEWS').every((x) => x.authority === 'NONE'));
  const status = (state, lastSuccessTs, lastError = null) => ({ v: 'press-status-1', tsMs: now, enabled: true, authority: 'NONE', sources: { COINDESK_NEWS: { kind: 'PUBLISHER', route: 'RSS', desired: 'ON', state, cadenceSec: 600, terms: 'UNVERIFIED', coverage: 'HEADLINE_LINK_ONLY', lastReceiptTs: now, lastSuccessTs, lastOutcome: null, lastError, backoffUntil: null, prerequisite: null, counters: { polls: 1, admitted: 1 } } } });
  writeFileSync(pressStatusFile(dir), JSON.stringify(status('OBSERVED', now - 1000))); assert.equal(snapshotRow(sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now }), 'PRESS_COINDESK_NEWS').state, 'ACTIVE');
  assert.equal(snapshotRow(sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now: now + 2 * 3_600_000 }), 'PRESS_COINDESK_NEWS').state, 'ACTIVE_DEGRADED', 'stale success -> degraded, never green');
  writeFileSync(pressStatusFile(dir), JSON.stringify(status('FAILED', null, 'HTTP 503'))); const f = snapshotRow(sensorSnapshot({ profile: p, env: { ...env }, dataDir: dir, now }), 'PRESS_COINDESK_NEWS'); assert.equal(f.state, 'BLOCKED_PROVIDER'); assert.equal(f.blocker, 'HTTP 503');
  assert.equal(snapshotRow(sensorSnapshot({ profile: p, env: { ...env, PRESS_ENABLED: 'false' }, dataDir: dir, now }), 'PRESS_COINDESK_NEWS').state, 'DISABLED_BY_PAPER_POLICY');
});

test('PRESS-5. composition + authority fences: fly.js starts the press collector after the gateway and before the tape; press/ imports no trading, control, research or RUMOR-2 runtime module (only the pure feed parser); no authority module imports press/; the frozen RUMOR-2 core still names no publisher; the registry carries no value-like secret', () => {
  const fly = readFileSync(path.join(REPO, 'fly.js'), 'utf8'); assert.ok(fly.includes("import { startPress } from './press/collector.js';")); assert.ok(fly.indexOf('startGateway();') < fly.indexOf('startPress();')); assert.ok(fly.indexOf('startPress();') < fly.indexOf('await runTape('));
  const tracked = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.js'));
  const imports = (f) => [...readFileSync(path.join(REPO, f), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const f of tracked.filter((x) => x.startsWith('press/'))) for (const spec of imports(f)) { assert.ok(!/judge\/|execution\/|watch\/|tape\/|ledger\/|cost\/|state\/|market-lab\/|socrates\/|research\//.test(spec), `${f} -> ${spec}`); if (spec.includes('rumor2/')) assert.equal(spec, '../rumor2/feed.js', `${f} reuses only the pure parser`); }
  for (const f of tracked.filter((x) => /^(judge|execution|watch|tape|ledger|cost|state|rumor2|market-lab|socrates)\//.test(x))) assert.ok(!imports(f).some((s) => s.includes('press/')), `${f} imports press/`);
  const core = readFileSync(path.join(REPO, 'rumor2/registry.js'), 'utf8').toLowerCase(); for (const b of ['reuters', 'bloomberg', 'cnbc', 'coindesk', 'decrypt.co']) assert.ok(!core.includes(b), `frozen core names ${b}`);
  assert.ok(!/sk-ant|sk_live|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}/i.test(readFileSync(path.join(REPO, 'press/registry.js'), 'utf8')));
});
