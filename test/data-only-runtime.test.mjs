import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'tools', 'data-only-runtime.mjs');
const forbidden = [
  `${path.sep}fly.js`, `${path.sep}paper${path.sep}`, `${path.sep}judge${path.sep}`,
  `${path.sep}execution${path.sep}`, `${path.sep}watch${path.sep}`, `${path.sep}tape${path.sep}run.js`,
  `${path.sep}bin${path.sep}cobra.js`,
];

function importGraph(file, seen = new Set()) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) return seen;
  seen.add(absolute);
  const source = readFileSync(absolute, 'utf8');
  const specs = [...source.matchAll(/(?:from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)].map((match) => match[2]);
  for (const spec of specs) {
    let next = path.resolve(path.dirname(absolute), spec);
    if (!path.extname(next)) next += '.js';
    importGraph(next, seen);
  }
  return seen;
}

// runtime unification step 1 (2026-09-14): the entry keeps the safety pins and calls lib/serpent-runtime.js, which holds the
// spine verbatim. Step 2: the spine delegates durable restore to lib/external-quota.js and the collector set to
// lib/collectors.js (env injected as `env`, defaulting to process.env; phases set through phase()). Source-shape assertions
// read entry + spine + quota + collectors IN THAT ORDER (the startup order), so the index comparisons below still hold; the
// import-graph fence walks all of them.
const spine = path.join(root, 'lib', 'serpent-runtime.js');
const spineModules = [spine, path.join(root, 'lib', 'external-quota.js'), path.join(root, 'lib', 'collectors.js')];
const entryAndSpine = () => [entry, ...spineModules].map((file) => readFileSync(file, 'utf8')).join('\n');

test('data-only entrypoint import graph contains no trading composition or order runtime', () => {
  const graph = [...importGraph(entry), ...spineModules.flatMap((file) => [...importGraph(file)])];
  for (const file of graph) for (const denied of forbidden) assert.equal(file.includes(denied), false, `forbidden data-only dependency: ${file}`);
  for (const file of spineModules) assert.ok(graph.includes(path.resolve(file)), `the entry reaches ${path.basename(file)}`);
  const source = entryAndSpine();
  assert.match(source, /JUDGE_ENABLED:\s*'false'/);
  assert.match(source, /JUDGE_ALLOW_ORDERS:\s*'false'/);
  assert.match(source, /nominationEnabled:\s*false/);
  assert.match(source, /maxMonthlyUsd:\s*0/);
});

test('data-only launcher derives official/social scope from the accepted catalog without a named fallback', () => {
  const source = entryAndSpine();
  assert.match(source, /catalog\.markets\.map\(\(market\) => market\.base\)/);
  assert.doesNotMatch(source, /\b(?:BTC|ETH|SOL)\b/);
  assert.match(source, /namedPreference:\s*false/);
});

test('data-only launcher starts and reports zero-order market observations with its own guarded transport', () => {
  const source = entryAndSpine();
  assert.match(source, /from '\.\.\/tools\/data-only-market\.mjs'/);
  assert.match(source, /market = await startDataOnlyMarket\(\{ env, dataDir: root, log, quotaJournal: checkpoints\.market \}\)/);
  assert.match(source, /handles\.push\(market\)/);
  assert.match(source, /market:\s*market\?\.status\?\.\(\)/);
  assert.match(source, /blockers\.MARKET/);
});

test('outer market funnel subscribes the complete accepted catalog independently of the deep subject list', () => {
  const source = entryAndSpine();
  assert.match(source, /from '\.\.\/market-lab\/broad-kraken\.js'/);
  assert.match(source, /const broadOpts = \{ catalogSource, dataDir: root, log \}/);
  assert.match(source, /broadMarket = await startBroadKraken\(broadOpts\)/);
  assert.match(source, /handles\.push\(broadMarket\)/);
  assert.match(source, /broadMarket:\s*broadMarket\?\.status\?\.\(\)/);
  assert.match(source, /blockers\.BROAD_MARKET/);
  assert.ok(source.indexOf('await wideEye._refreshCatalog()') < source.indexOf('await startBroadKraken('));
  assert.ok(source.indexOf('await openDataOnlyCheckpoints(') < source.indexOf('await startBroadKraken('));
  assert.doesNotMatch(source, /\b(?:BTC|ETH|SOL)\b|composeDataOnlySocialConfig/);
  const broad = source.slice(source.indexOf('if (catalogSource)'), source.indexOf('  if (catalog) {'));
  assert.match(broad, /startBroadKraken/);
  assert.doesNotMatch(broad, /checkpoints\?\.market|if \(catalog\)/);
  assert.match(source, /if \(!checkpoints\?\.market\) throw/, 'deep REST quota gate is preserved');
});

test('LEAN PASS 4a: the data-only deployment no longer composes a YouTube / social-video collector', () => {
  const source = entryAndSpine();
  const supervisor = readFileSync(path.join(root, 'tools', 'data-only-with-ui.mjs'), 'utf8');
  for (const text of [source, supervisor]) {
    assert.doesNotMatch(text, /SOCIAL_VIDEO_ENABLED/, 'the retired social-video tier leaves no env behind');
  }
  assert.doesNotMatch(source, /video\/collector\.js|video\/reader\.js|startVideo|readVideoStatus|blockers\.YOUTUBE/, 'no video collector is imported or composed');
});

test('data-only news uses official feeds only and withholds unverified publisher text (LEAN PASS 4a retired the GDELT/discovery tier)', () => {
  const source = entryAndSpine();
  assert.doesNotMatch(source, /startPress|readPressStatus|PRESS_ENABLED:\s*'true'/);
  assert.doesNotMatch(source, /COINDESK_NEWS|THEBLOCK_NEWS|COINTELEGRAPH_NEWS|DECRYPT_NEWS/);
  assert.doesNotMatch(source, /DISCOVERY_SOURCES|GDELT_NEWS_DISCOVERY|POLYMARKET_PUBLIC_DATA|KALSHI_PUBLIC_DATA|startPublicDiscovery/, 'no discovery collector is composed');
  assert.match(source, /state:\s*'WITHHELD_TERMS_UNVERIFIED'/);
  assert.match(source, /excerptsStored:\s*false/);
  assert.match(source, /publisherFulltextStored:\s*false/);
  assert.match(source, /publisherExcerptsStored:\s*false/);
  assert.match(source, /contact:\s*env\.SERPENT_HTTP_CONTACT \?\? null/);
  assert.match(source, /edgarEnabled:\s*false/);
  assert.match(source, /CFTC_OFFICIAL:\s*officialFeed\('CFTC_OFFICIAL'\)/);
  assert.match(source, /SEC_OFFICIAL:\s*officialFeed\('SEC_OFFICIAL'\)/);
});

test('Replit run and deployment commands select the ONE-process data-only entry, not the paper runtime (runtime unification step 4)', () => {
  const replit = readFileSync(path.join(root, '.replit'), 'utf8');
  const shim = readFileSync(path.join(root, 'tools', 'data-only-with-ui.mjs'), 'utf8');
  assert.match(replit, /^run = "npm run data:only-ui"/m);
  assert.match(replit, /\[deployment\][\s\S]*run = \["npm", "run", "data:only-ui"\]/);
  assert.doesNotMatch(replit, /npm run paper|paper run/);
  // the two-process supervisor is retired: the deployment entry pins the safety posture, then enters the one root,
  // which runs the spine and serves the cockpit in-process (no child process, no second pump, no port race)
  assert.match(shim, /SERPENT_DATA_ONLY:\s*'true'/);
  assert.match(shim, /await import\('\.\.\/fly\.js'\)/);
  assert.doesNotMatch(shim, /child_process|spawn\(/, 'one process: nothing is supervised');
  assert.ok(shim.indexOf('Object.assign(process.env') < shim.indexOf("await import('../fly.js')"), 'the safety posture is established before any project module is evaluated');
  assert.ok(shim.indexOf('delete process.env.COBRA_PROFILE') >= 0 && shim.indexOf('delete process.env.COBRA_PROFILE') < shim.indexOf("await import('../fly.js')"), 'a stray profile name cannot make the shim derive PAPER');
  // and the one root serves the cockpit in-process in DATA_ONLY, after the spine (persistence bootstrap first)
  const fly = readFileSync(path.join(root, 'fly.js'), 'utf8');
  assert.ok(fly.indexOf("startDataOnlyRuntime({ entrypoint: 'fly.js' })") < fly.indexOf("await import('./ui/server.js')"), 'DATA_ONLY: the cockpit listens only after the spine established the persistence bootstrap');
  // PUBLISH-FIX-3 PORT FIRST: a bootstrap STARTING responder binds PORT before the legacy purge and the spine, then is
  // closed the instant before the real cockpit binds the same port — so the healthcheck passes while PERSIST-0A §2 holds.
  assert.ok(fly.indexOf('bootstrap STARTING responder') < fly.indexOf('purgeLegacyData('), 'the bootstrap binds PORT before the legacy purge');
  assert.ok(fly.indexOf("server.listen(port, '0.0.0.0'") < fly.indexOf("startDataOnlyRuntime({ entrypoint: 'fly.js' })"), 'the bootstrap binds before the spine restores persistence');
  assert.match(fly, /await bootstrap\.close\(\);\s*\n\s*await import\('\.\/ui\/server\.js'\)/g, 'the bootstrap is released the instant before the real cockpit binds the same port');
  assert.doesNotMatch(fly.slice(fly.indexOf('bootstrap STARTING responder'), fly.indexOf('await bootstrap.close()')), /\/api\/control|gateControl|kill|cage/, 'the bootstrap window exposes no control surface');
});

test('both data-only launchers explicitly keep paid X collection disabled during broad-market rollout', () => {
  for (const file of [entry, path.join(root, 'tools', 'data-only-with-ui.mjs')]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /RUMOR2_SOCIAL_X_ENABLED:\s*'false'/);
    assert.doesNotMatch(source, /RUMOR2_SOCIAL_X_ENABLED:\s*'true'/);
  }
});

test('startup publishes process identity and restores external quotas before any provider starts', () => {
  const source = entryAndSpine();
  const initialStatus = source.indexOf('writeStartupStatus();');
  const persistenceStart = source.indexOf('await startPersistence({ log, registerSignals: false })');
  const checkpointStart = source.indexOf('await openDataOnlyCheckpoints(');
  const marketStart = source.indexOf('await startDataOnlyMarket(');
  const wideEyeStart = source.indexOf('wideEye = startWideEye(');
  assert.ok(initialStatus > 0 && initialStatus < persistenceStart);
  assert.ok(persistenceStart < checkpointStart && checkpointStart < marketStart && checkpointStart < wideEyeStart);
  assert.doesNotMatch(source, /await wideEye\._sweepOnce\(\)/);
  assert.match(source, /openedTs: startedTs/);
  assert.doesNotMatch(source, /durableCheckpoint: checkpoints\.discovery/, 'LEAN PASS 4a: no discovery collector remains');
  assert.ok(source.indexOf('await checkpoints?.close?.()') < source.indexOf('await persistence?.stop?.()'));
});
